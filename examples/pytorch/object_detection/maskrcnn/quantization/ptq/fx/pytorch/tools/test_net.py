# Copyright (c) 2021, NVIDIA CORPORATION. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
# Set up custom environment before nearly anything else is imported
# NOTE: this should be the first import (no not reorder)
from maskrcnn_benchmark.utils.env import setup_environment  # noqa F401 isort:skip

import argparse
import os

import torch
from maskrcnn_benchmark.config import cfg
from maskrcnn_benchmark.data import make_data_loader
from maskrcnn_benchmark.engine.inference import inference
from maskrcnn_benchmark.modeling.detector import build_detection_model
from maskrcnn_benchmark.utils.checkpoint import DetectronCheckpointer
from maskrcnn_benchmark.utils.collect_env import collect_env_info
from maskrcnn_benchmark.utils.comm import synchronize, get_rank
from maskrcnn_benchmark.utils.logger import setup_logger
from maskrcnn_benchmark.utils.miscellaneous import mkdir
from maskrcnn_benchmark.modeling.rpn.anchor_generator import AnchorGenerator
from maskrcnn_benchmark.modeling.rpn.inference import RPNPostProcessor
from maskrcnn_benchmark.modeling.rpn.rpn import RPNModule, RPNHead
from maskrcnn_benchmark.modeling.poolers import Pooler
from maskrcnn_benchmark.modeling.roi_heads.box_head.inference import PostProcessor
from maskrcnn_benchmark.modeling.roi_heads.mask_head.roi_mask_feature_extractors import MaskRCNNFPNFeatureExtractor
from maskrcnn_benchmark.modeling.roi_heads.mask_head.mask_head import ROIMaskHead
from maskrcnn_benchmark.modeling.roi_heads.mask_head.inference import MaskPostProcessor
from maskrcnn_benchmark.modeling.roi_heads.roi_heads import CombinedROIHeads
from maskrcnn_benchmark.layers.misc import ConvTranspose2d
from maskrcnn_benchmark.modeling.backbone.fpn import FPN


def main():
    parser = argparse.ArgumentParser(description="PyTorch Object Detection Inference")
    parser.add_argument('-t', '--tune', dest='tune', action='store_true',
                        help='tune best int8 model on calibration dataset')
    parser.add_argument('-i', "--iter", default=0, type=int,
                        help='For accuracy measurement only.')
    parser.add_argument('-w', "--warmup_iter", default=5, type=int,
                        help='For benchmark measurement only.')
    parser.add_argument('--benchmark', dest='benchmark', action='store_true',
                        help='run benchmark')
    parser.add_argument('-r', "--accuracy_only", dest='accuracy_only', action='store_true',
                        help='For accuracy measurement only.')
    parser.add_argument("--tuned_checkpoint", default='./saved_results', type=str, metavar='PATH',
                        help='path to checkpoint tuned by Neural Compressor (default: ./saved_results)')
    parser.add_argument('--int8', dest='int8', action='store_true',
                        help='run benchmark')
    parser.add_argument(
        "--config-file",
        default="/private/home/fmassa/github/detectron.pytorch_v2/configs/e2e_faster_rcnn_R_50_C4_1x_caffe2.yaml",
        metavar="FILE",
        help="path to config file",
    )
    parser.add_argument("--local_rank", type=int, default=0)
    parser.add_argument(
        "opts",
        help="Modify config options using the command-line",
        default=None,
        nargs=argparse.REMAINDER,
    )

    args = parser.parse_args()

    num_gpus = int(os.environ["WORLD_SIZE"]) if "WORLD_SIZE" in os.environ else 1
    distributed = num_gpus > 1

    if distributed:
        torch.cuda.set_device(args.local_rank)
        torch.distributed.init_process_group(
            backend="nccl", init_method="env://"
        )
        synchronize()

    cfg.merge_from_file(args.config_file)
    cfg.merge_from_list(args.opts)
    cfg.freeze()

    save_dir = ""
    logger = setup_logger("maskrcnn_benchmark", save_dir, get_rank())
    logger.info("Using {} GPUs".format(num_gpus))
    logger.info(cfg)

    logger.info("Collecting env info (might take some time)")
    logger.info("\n" + collect_env_info())

    model = build_detection_model(cfg)
    model.to(cfg.MODEL.DEVICE)

    output_dir = cfg.OUTPUT_DIR
    checkpointer = DetectronCheckpointer(cfg, model, save_dir=output_dir)
    _ = checkpointer.load(cfg.MODEL.WEIGHT)

    iou_types = ("bbox",)
    if cfg.MODEL.MASK_ON:
        iou_types = iou_types + ("segm",)
    if cfg.MODEL.KEYPOINT_ON:
        iou_types = iou_types + ("keypoints",)

    class MASKRCNN_DataLoader(object):
        def __init__(self, loaders=None):
            self.loaders = loaders
            self.batch_size = 1

        def __iter__(self):
            for loader in self.loaders:
                for batch in loader:
                    images, targets, image_ids = batch
                    yield images, targets

    global iters
    iters = None

    def eval_func(q_model):
        output_folders = [None] * len(cfg.DATASETS.TEST)
        dataset_names = cfg.DATASETS.TEST
        if cfg.OUTPUT_DIR:
            for idx, dataset_name in enumerate(dataset_names):
                output_folder = os.path.join(cfg.OUTPUT_DIR, "inference", dataset_name)
                mkdir(output_folder)
                output_folders[idx] = output_folder
        data_loaders_val = make_data_loader(cfg, is_train=False, is_distributed=distributed, iters=iters)
        for output_folder, dataset_name, data_loader_val in zip(output_folders, dataset_names, data_loaders_val):
            results, _ = inference(
                q_model,
                data_loader_val,
                dataset_name=dataset_name,
                iou_types=iou_types,
                box_only=False if cfg.MODEL.RETINANET_ON else cfg.MODEL.RPN_ONLY,
                device=cfg.MODEL.DEVICE,
                expected_results=cfg.TEST.EXPECTED_RESULTS,
                expected_results_sigma_tol=cfg.TEST.EXPECTED_RESULTS_SIGMA_TOL,
                output_folder=output_folder,
            )
            synchronize()
        if not args.benchmark:
            print('Batch size = %d' % cfg.TEST.IMS_PER_BATCH)
            print('Accuracy: %.3f ' % (results.results['bbox']['AP']))
        return results.results['bbox']['AP']

    model.eval()
    prepare_custom_config_dict = {"non_traceable_module_class": [
       AnchorGenerator, RPNPostProcessor, Pooler, PostProcessor, MaskRCNNFPNFeatureExtractor,
       MaskPostProcessor, FPN, RPNHead
    ]}
    if args.tune:
        from neural_compressor.experimental import Quantization, common
        quantizer = Quantization("./conf.yaml")
        data_loaders_val = make_data_loader(cfg, is_train=False,
                                            is_distributed=distributed, is_calib=True)
        cal_dataloader = MASKRCNN_DataLoader(data_loaders_val)
        quantizer.model = common.Model(model,
                                       **{'prepare_custom_config_dict': prepare_custom_config_dict}
                                      )
        quantizer.calib_dataloader = cal_dataloader
        quantizer.eval_func = eval_func
        q_model = quantizer.fit()
        q_model.save(args.tuned_checkpoint)
        return

    if args.int8:
        from neural_compressor.utils.pytorch import load
        model = load(os.path.abspath(os.path.expanduser(args.tuned_checkpoint)), model,
                     **{'prepare_custom_config_dict': prepare_custom_config_dict})
    if args.benchmark:
        iters = args.iter
        eval_func(model)
    elif args.accuracy_only:
        eval_func(model)
    return


if __name__ == "__main__":
    main()
