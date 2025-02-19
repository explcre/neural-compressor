Step-by-Step
============

# Prerequisite
1.1 Install python environment
### 1. Installation
  ```shell
  conda create -n <env name> python=3.7
  conda activate <env name>
  cd <nc_folder>/examples/deepengine/nlp/bert_large
  pip install 1.15.0 up2 from links below:
  https://storage.googleapis.com/intel-optimized-tensorflow/intel_tensorflow-1.15.0up2-cp37-cp37m-manylinux2010_x86_64.whl
  pip install -r requirements.txt
  ```
1.2 Install C++ environment (Optional)
Install engine according to [Engine](../../../../../docs/engine.md) if need the performance in C++.
Preload libiomp5.so can improve the performance when bs=1.
```
export LD_PRELOAD=<path_to_libiomp5.so>
```
### 2. Prepare Dataset and Model
### 2.1 Prepare Dataset
  ```shell
  bash prepare_dataset.sh
  ```
  Note: Replace the data path in bert_static.yaml and bert_dynamic.yaml

### 2.2 Download TensorFlow model (The model will be in build/data/bert_tf_v1_1_large_fp32_384_v2 folder):
  ```shell
  bash prepare_model.sh
  ```

### 2.3 Get the frozen pb model (The model.pb will be in build/data):
  ```shell
  python tf_freeze_bert.py
  ```

### Run

### 1. To get the tuned model and its accuracy:
  run python
  ```shell
  GLOG_minloglevel=2 python run_engine.py --tune
  ```
  or run shell
  ```shell
  bash run_tuning.sh --config=bert_static.yaml --input_model=build/data/model.pb --output_model=ir --dataset_location=build/data
  ```

### 2. To get the benchmark of tuned model:
  2.1 accuracy
  run python
  ```shell
  GLOG_minloglevel=2 python run_engine.py --input_model=./ir --benchmark --mode=accuracy --batch_size=1
  ```
  or run shell
  ```shell
  bash run_benchmark.sh --config=bert_static.yaml --input_model=ir --dataset_location=build/data --batch_size=1 --mode=accuracy
  ```

  2.2 performance
  run python
  ```shell
  GLOG_minloglevel=2 python run_engine.py --input_model=./ir --benchmark --mode=performance --batch_size=1
  ```
  or run shell
  ```shell
  bash run_benchmark.sh --config=bert_static.yaml --input_model=ir --dataset_location=build/data --batch_size=1 --mode=performance
  ```
  or run C++
  The warmup below is recommended to be 1/10 of iterations and no less than 3.
  ```
  export GLOG_minloglevel=2
  export OMP_NUM_THREADS=<cpu_cores>
  export DNNL_MAX_CPU_ISA=AVX512_CORE_AMX
  numactl -C 0-<cpu_cores-1> <neural_compressor_folder>/engine/bin/inferencer --batch_size=<batch_size> --iterations=<iterations> --w=<warmup> --seq_len=384 --config=./ir/conf.yaml --weight=./ir/model.bin
  ```
