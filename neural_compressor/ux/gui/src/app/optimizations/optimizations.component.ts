// Copyright (c) 2021 Intel Corporation
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
import { Component, ElementRef, Input, OnInit, ViewChild } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router } from '@angular/router';
import { environment } from 'src/environments/environment';
import { OptimizationFormComponent } from '../optimization-form/optimization-form.component';
import { PinBenchmarkComponent } from '../pin-benchmark/pin-benchmark.component';
import { ModelService } from '../services/model.service';
import { SocketService } from '../services/socket.service';
declare var require: any;
var shajs = require('sha.js');

@Component({
  selector: 'app-optimizations',
  templateUrl: './optimizations.component.html',
  styleUrls: ['./optimizations.component.scss', './../error/error.component.scss', './../home/home.component.scss', './../datasets/datasets.component.scss']
})
export class OptimizationsComponent implements OnInit {

  apiBaseUrl = environment.baseUrl;
  token = '';

  @ViewChild("accChart", { read: ElementRef, static: false }) accChartRef: ElementRef;
  @ViewChild("perfChart", { read: ElementRef, static: false }) perfChartRef: ElementRef;

  @Input() framework: string;
  model = {};
  historyData = {};
  optimizations = [];
  activeOptimizationId = 0;
  requestId = '';
  optimizationDetails: any;
  pinnedAccuracyBenchmarks = {};
  pinnedPerformanceBenchmarks = {};
  allBenchmarks = [];
  availableAccuracyBenchmarks = {};
  availablePerformanceBenchmarks = {};
  showAccuracyDropdown = {};
  showPerformanceDropdown = {};
  labels = ['Input', 'Optimized'];

  xAxis: boolean = true;
  yAxis: boolean = true;
  showYAxisLabel: boolean = true;
  showXAxisLabel: boolean = true;
  viewLine: any[] = [600, 300];
  referenceLines = {
    accuracy: {},
    performance: {}
  };
  chartsReady = false;

  colorScheme = {
    domain: [
      '#0095CA',
      '#004A86',
      '#EDB200',
      '#B24501',
      '#41728A',
      '#525252',
      '#653171',
      '#708541',
      '#000F8A',
      '#C81326',
      '#005B85',
      '#183544',
      '#515A3D',
      '#C98F00',]
  };

  constructor(
    private modelService: ModelService,
    private socketService: SocketService,
    public activatedRoute: ActivatedRoute,
    public dialog: MatDialog,
    private router: Router) {
  }

  ngOnInit() {
    this.initializeOptimizations();
    this.token = this.modelService.getToken();
    this.modelService.projectChanged$
      .subscribe(response => {
        this.getOptimizations(response['id']);
        this.optimizationDetails = null;
        this.activeOptimizationId = -1;
      });
  }

  initializeOptimizations(): void {
    this.getOptimizations();
    this.modelService.optimizationCreated$
      .subscribe(response => this.getOptimizations());
    this.socketService.benchmarkFinish$
      .subscribe(response => this.getOptimizations());
    this.socketService.optimizationFinish$
      .subscribe(response => {
        if (String(this.activatedRoute.snapshot.params.id) === String(response['data']['project_id'])) {
          this.getOptimizations();
          if (this.activeOptimizationId > 0) {
            this.getOptimizationDetails(this.activeOptimizationId);
          }
        }
      });
    this.socketService.tuningHistory$
      .subscribe(response => {
        if (response['status'] === 'success' && this.activeOptimizationId === response['data']['optimization_id']) {
          this.getHistoryData(response['data']);
        }
      });
  }

  getOptimizations(id?: number) {
    this.modelService.getOptimizationList(id ?? this.activatedRoute.snapshot.params.id)
      .subscribe(
        response => {
          this.optimizations = response['optimizations'];
          this.getBenchmarksList();
        },
        error => {
          this.modelService.openErrorDialog(error);
        });
  }

  getBenchmarksList(id?: number) {
    this.modelService.getBenchmarksList(id ?? this.activatedRoute.snapshot.params.id)
      .subscribe(
        response => {
          this.allBenchmarks = response['benchmarks'];

          this.optimizations.forEach(optimization => {
            this.availableAccuracyBenchmarks[optimization.id] = this.allBenchmarks.filter(x =>
              x.model.name.toLowerCase().replace(' ', '_') === optimization.name.toLowerCase().replace(' ', '_')
              && x.mode === 'accuracy');

            this.availablePerformanceBenchmarks[optimization.id] = this.allBenchmarks.filter(x =>
              x.model.name.toLowerCase().replace(' ', '_') === optimization.name.toLowerCase().replace(' ', '_')
              && x.mode === 'performance');

            this.pinnedAccuracyBenchmarks[optimization.id] = this.allBenchmarks.find(x => x.id === optimization.accuracy_benchmark_id);
            this.pinnedPerformanceBenchmarks[optimization.id] = this.allBenchmarks.find(x => x.id === optimization.performance_benchmark_id);
          });
        },
        error => {
          this.modelService.openErrorDialog(error);
        });
  }

  openPinDialog(mode: string, optimizationId: number) {
    let benchmarks = [];
    if (mode === 'accuracy' && this.availableAccuracyBenchmarks[optimizationId]) {
      benchmarks = this.availableAccuracyBenchmarks[optimizationId]
    } else if (mode === 'performance' && this.availablePerformanceBenchmarks[optimizationId]) {
      benchmarks = this.availablePerformanceBenchmarks[optimizationId]
    }

    if ((mode === 'accuracy' && this.availableAccuracyBenchmarks[optimizationId].length)
      || (mode === 'performance' && this.availablePerformanceBenchmarks[optimizationId].length)) {
      const dialogRef = this.dialog.open(PinBenchmarkComponent, {
        data: {
          mode: mode,
          optimizationId: optimizationId,
          benchmarks: benchmarks
        }
      });

      dialogRef.afterClosed()
        .subscribe(response => {
          if (response) {
            if (mode === 'accuracy') {
              this.pinnedAccuracyBenchmarks[optimizationId] = this.allBenchmarks.find(x => x.id === response.chosenBenchmarkId);
            } else if (mode === 'performance') {
              this.pinnedPerformanceBenchmarks[optimizationId] = this.allBenchmarks.find(x => x.id === response.chosenBenchmarkId);
            }
            this.getOptimizations();
          }
        });
    }
  }

  getOptimizationDetails(id) {
    this.activeOptimizationId = id;
    this.modelService.getOptimizationDetails(id)
      .subscribe(
        response => {
          this.optimizationDetails = response;
          if (response['tuning_details']['tuning_history']) {
            this.getHistoryData(response['tuning_details']['tuning_history']);
          } else {
            this.historyData = {};
            this.chartsReady = false;
          }
        },
        error => {
          this.modelService.openErrorDialog(error);
        });
  }

  addOptimization() {
    const dialogRef = this.dialog.open(OptimizationFormComponent, {
      width: '60%',
      data:
      {
        projectId: this.activatedRoute.snapshot.params.id,
        index: this.optimizations.length,
        framework: this.framework
      }
    });
  }

  executeOptimization(optimizationId) {
    const dateTime = Date.now();
    this.requestId = shajs('sha384').update(String(dateTime)).digest('hex');

    this.optimizations.find(optimization => optimization.id === optimizationId)['status'] = 'wip';
    this.optimizations.find(optimization => optimization.id === optimizationId)['requestId'] = this.requestId;
    this.modelService.executeOptimization(optimizationId, this.requestId)
      .subscribe(
        response => { },
        error => {
          this.modelService.openErrorDialog(error);
        }
      );
  }

  getHistoryData(result) {
    ['accuracy', 'performance'].forEach(type => {
      this.historyData[type] = [{
        "name": type,
        "series": []
      }];

      result['history'].forEach((record, index) => {
        if (result['baseline_' + type]) {
          this.historyData[type][0]['series'].push({
            name: index + 1,
            value: record[type][0]
          });
        }
      });

      this.referenceLines[type] = [{
        name: 'baseline ' + type,
        value: result['baseline_' + type]
      }];
    });

    if (this.historyData['accuracy'][0]['series'].length || this.historyData['performance'][0]['series']) {
      this.chartsReady = true;
    }

    setTimeout(() => { this.fixChart() }, 1000);
  }

  fixChart() {
    this.accChartRef.nativeElement.querySelectorAll("g.line-series path").forEach((el) => {
      el.setAttribute("stroke-width", "10");
      el.setAttribute("stroke-linecap", "round");
    });
    this.perfChartRef.nativeElement.querySelectorAll("g.line-series path").forEach((el) => {
      el.setAttribute("stroke-width", "10");
      el.setAttribute("stroke-linecap", "round");
    });
  }

  axisFormat(val) {
    if (val % 1 === 0) {
      return val.toLocaleString();
    } else {
      return '';
    }
  }

  goToBenchmarks() {
    this.router.navigate(['project', this.activatedRoute.snapshot.params.id, 'benchmarks'], { queryParamsHandling: "merge" });
    this.modelService.projectChanged$.next({ id: this.activatedRoute.snapshot.params.id, tab: 'benchmarks' });
  }

  typeOf(object) {
    return typeof object;
  }

  copyToClipboard(text: string) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      console.error('Unable to copy', err);
    }
    document.body.removeChild(textArea);
  }
}
