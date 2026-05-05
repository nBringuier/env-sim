import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { lastValueFrom, BehaviorSubject, Observable } from 'rxjs';

export interface ApiResponse {
  name: string;
  version: string;
  timestamp: string;
}

export interface EngineStatus {
  running: boolean;
  simuTime: number;
  timeScale: number;
  paused: boolean;
  timestamp: number;
}

@Injectable({ providedIn: 'root' })
export class AppService {
  private apiResponse?: ApiResponse;
  private webSocket?: WebSocket;
  private engineStatusSubject = new BehaviorSubject<EngineStatus | null>(null);
  public engineStatus$ = this.engineStatusSubject.asObservable();

  constructor(private http: HttpClient) {}

  initialize(): Promise<void> {
    return lastValueFrom(this.http.get<ApiResponse>('/api'))
      .then((api) => {
        this.apiResponse = api;
        // Auto-connect WebSocket after initialization
        this.connectWebSocket();
      })
      .catch(() => {
        this.apiResponse = {
          name: 'undefined',
          version: 'unknown',
          timestamp: new Date().toISOString(),
        };
      });
  }

  private connectWebSocket(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/engine`;

    this.webSocket = new WebSocket(wsUrl);
    this.webSocket.onopen = () => {
      console.log('WebSocket connected');
    };

    this.webSocket.onmessage = (event) => {
      try {
        const status: EngineStatus = JSON.parse(event.data);
        this.engineStatusSubject.next(status);
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };

    this.webSocket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    this.webSocket.onclose = () => {
      console.log('WebSocket disconnected');
      // Attempt to reconnect after 3 seconds
      setTimeout(() => this.connectWebSocket(), 3000);
    };
  }

  disconnectWebSocket(): void {
    if (this.webSocket) {
      this.webSocket.close();
      this.webSocket = undefined;
    }
  }

  getLatestEngineStatus(): EngineStatus | null {
    return this.engineStatusSubject.value;
  }

  getApiResponse(): ApiResponse | undefined {
    return this.apiResponse;
  }

  start(): Promise<any> {
    return lastValueFrom(this.http.post('/api/engine/start', {}));
  }

  stop(): Promise<any> {
    return lastValueFrom(this.http.post('/api/engine/stop', {}));
  }

  pause(): Promise<any> {
    return lastValueFrom(this.http.post('/api/engine/pause', {}));
  }

  resume(): Promise<any> {
    return lastValueFrom(this.http.post('/api/engine/resume', {}));
  }

  generateScenario(): Promise<any> {
    return lastValueFrom(this.http.get('/api/engine/generate-scenario'));
  }

  getScenario(): Promise<any> {
    return lastValueFrom(this.http.get('/api/engine/scenario'));
  }

  postScenario(scenario: any): Promise<any> {
    return lastValueFrom(this.http.post('/api/engine/scenario', scenario));
  }

  getStatus(): Promise<any> {
    return lastValueFrom(this.http.get('/api/engine/status'));
  }

  setTimeScale(scale: number): Promise<any> {
    return lastValueFrom(this.http.post('/api/engine/timeScale', {}, { params: { scale: scale.toString() } }));
  }

  setRunUntil(time: number): Promise<any> {
    return lastValueFrom(this.http.post('/api/engine/runUntil', {}, { params: { time: time.toString() } }));
  }
}
