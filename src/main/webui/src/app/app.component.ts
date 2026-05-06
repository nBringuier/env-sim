import { Component, inject, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Title } from '@angular/platform-browser';
import { AppService, EngineStatus } from '../services/app.service';
import { StringUtils } from '../utils/StringUtils';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-root',
  imports: [CommonModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit, OnDestroy {
  title = 'WebUI';
  scenarioJson = '';
  statusMessage = '';
  editorError = '';

  // Status properties
  isRunning = false;
  simuTime = 0;
  timeScale = 1.0;
  isPaused = false;

  private readonly titleService = inject(Title);
  private readonly appService = inject(AppService);
  private statusSubscription?: Subscription;

  ngOnInit() {
    const api = this.appService.getApiResponse();
    if (api) {
      this.title = StringUtils.kebabToPascal(api.name) + ' ' + api.version;
      this.titleService.setTitle(this.title);
    }
    this.refreshStatus();

    // Subscribe to real-time engine status updates
    this.statusSubscription = this.appService.engineStatus$.subscribe((status: EngineStatus | null) => {
      if (status) {
        this.isRunning = status.running;
        this.simuTime = status.simuTime;
        this.timeScale = status.timeScale;
        this.isPaused = status.paused;
      }
    });
  }

  ngOnDestroy() {
    if (this.statusSubscription) {
      this.statusSubscription.unsubscribe();
    }
    this.appService.disconnectWebSocket();
  }

  async refreshStatus() {
    const status = await this.safeCall(() => this.appService.getStatus());
    if (status !== undefined) {
      this.isRunning = status.running;
      this.simuTime = status.simuTime;
      this.timeScale = status.timeScale;
      this.isPaused = status.paused;
    }
  }

  async start() {
    await this.callApiAction(() => this.appService.start(), 'Simulation started');
  }

  async stop() {
    await this.callApiAction(() => this.appService.stop(), 'Stop requested');
  }

  async pause() {
    await this.callApiAction(() => this.appService.pause(), 'Simulation paused');
  }

  async resume() {
    await this.callApiAction(() => this.appService.resume(), 'Simulation resumed');
  }

  async generateScenario() {
    const result = await this.safeCall(() => this.appService.generateScenario());
    if (result !== undefined) {
      this.scenarioJson = JSON.stringify(result, null, 2);
      this.statusMessage = 'Scenario generated successfully';
    }
  }

  async loadScenario() {
    const result = await this.safeCall(() => this.appService.getScenario());
    if (result !== undefined) {
      this.scenarioJson = JSON.stringify(result, null, 2);
      this.statusMessage = 'Scenario loaded successfully';
    }
  }

  async postScenario() {
    this.editorError = '';
    let parsed: any;
    try {
      parsed = JSON.parse(this.scenarioJson);
    } catch (error: any) {
      this.editorError = 'Invalid JSON: ' + error.message;
      return;
    }
    const result = await this.safeCall(() => this.appService.postScenario(parsed));
    if (result !== undefined) {
      this.scenarioJson = JSON.stringify(result, null, 2);
      this.statusMessage = 'Scenario posted successfully';
    }
  }

  saveScenarioAsFile() {
    if (!this.scenarioJson.trim()) {
      this.statusMessage = 'No scenario content to save';
      return;
    }

    try {
      // Validate JSON before saving
      JSON.parse(this.scenarioJson);

      const blob = new Blob([this.scenarioJson], { type: 'application/json' });
      const url = window.URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = `scenario-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      window.URL.revokeObjectURL(url);
      this.statusMessage = 'Scenario saved as JSON file';
    } catch (error: any) {
      this.editorError = 'Cannot save invalid JSON: ' + error.message;
    }
  }

  loadScenarioFromFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';

    input.onchange = (event: any) => {
      const file = event.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (e: any) => {
          try {
            const content = e.target.result;
            // Validate JSON
            JSON.parse(content);
            this.scenarioJson = content;
            this.editorError = '';
            this.statusMessage = `Scenario loaded from "${file.name}"`;
          } catch (error: any) {
            this.editorError = 'Invalid JSON file: ' + error.message;
          }
        };
        reader.readAsText(file);
      }
    };

    input.click();
  }


  async setTimeScale(scale: number) {
    await this.callApiAction(() => this.appService.setTimeScale(scale), `Time scale set to ${scale}x`);
  }

  async jump(deltaMs: number) {
    const status = await this.safeCall(() => this.appService.getStatus());
    if (status !== undefined) {
      const targetTime = status.simuTime + deltaMs;
      await this.callApiAction(() => this.appService.setRunUntil(targetTime), `Jump to ${targetTime}ms`);
    }
  }

  private async callApiAction(action: () => Promise<any>, successMessage: string) {
    const result = await this.safeCall(action);
    if (result !== undefined) {
      this.statusMessage = successMessage;
      await this.refreshStatus();
    }
  }

  private async safeCall(action: () => Promise<any>) {
    try {
      return await action();
    } catch (error: any) {
      this.statusMessage = 'Request failed: ' + (error?.message || 'unknown error');
      return undefined;
    }
  }
}
