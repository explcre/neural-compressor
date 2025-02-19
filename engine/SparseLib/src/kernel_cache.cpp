//  Copyright (c) 2021 Intel Corporation
//
//  Licensed under the Apache License, Version 2.0 (the "License");
//  you may not use this file except in compliance with the License.
//  You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
//  Unless required by applicable law or agreed to in writing, software
//  distributed under the License is distributed on an "AS IS" BASIS,
//  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//  See the License for the specific language governing permissions and
//  limitations under the License.

#include "kernel_cache.hpp"

namespace jd {
const std::shared_ptr<const kernel_framework_t>& kernel_cache::get(const operator_config& op_cfg) {
  auto it = cache_.find(op_cfg);
  if (it == cache_.end()) {
    static const std::shared_ptr<const kernel_framework_t> empty_ptr(nullptr);
    return empty_ptr;
  }
  return it->second;
}

const std::shared_ptr<const kernel_desc_t>& kernel_cache::get_kd(const operator_config& op_cfg) {
  auto e = get(op_cfg);
  if (e == nullptr) {
    static const std::shared_ptr<const kernel_desc_t> empty_ptr(nullptr);
    return empty_ptr;
  }
  return e->kd();
}

const std::shared_ptr<const kernel_framework_t>& kernel_cache::find_or_construct(const operator_config& op_cfg,
    const std::function<bool(std::shared_ptr<const kernel_framework_t>&)>& callback) {
  // For elements with the same key, allow the first element, block the rest elements.
  // Mark "cache_[key] = nullptr" as the first element, and "cache_[key] = BLOCK_REST" as the rests
  static bool BLOCK_REST = false;
  std::unique_lock<std::mutex> lk(mtx_);
  cv_.wait(lk, [&](){
    bool can_pass = (cache_[op_cfg] != nullptr) || ((cache_[op_cfg] == nullptr) && !BLOCK_REST);
    return can_pass;
  });

  if (cache_[op_cfg] != nullptr) {
    const auto& value = get(op_cfg);
    if (value != nullptr) {
      return value;
    }
  }
  BLOCK_REST = true;
  std::shared_ptr<const kernel_framework_t> derived_prim = nullptr;
  auto status = callback(derived_prim);
  set(derived_prim);
  BLOCK_REST = false;
  cv_.notify_all();
  return get(op_cfg);
}

void kernel_cache::set(const std::shared_ptr<const kernel_framework_t>& kernel) {
  const auto& key = kernel->kd()->operator_cfg();
  cache_[key] = kernel;
}
}  // namespace jd
