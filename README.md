 # Discrete Event Simulator

A real-time, web-based discrete event simulator built with **Java/Quarkus** backend and **Angular** frontend.

### Features

✅ **Event-Driven Simulation**
- Scenario-based architecture with hierarchical `ActiveObject` support
- JSON serializable/deserializable scenarios
- Real-time and accelerated simulation modes

✅ **Engine Control**
- Start, stop, pause, resume simulation
- Adjustable time scale (0.5x to 100x speed)
- Jump forward by time delta (1s, 10s, 1min)
- Fast-forward to specific simulation time

✅ **Scenario Management**
- Clone scenarios for parallel execution
- Backup/restore snapshots
- Load/edit scenarios via JSON editor
- Unique ID-based object lookup

✅ **Real-Time Monitoring**
- WebSocket live updates of engine state
- Status dashboard (running state, simulation time, speed)
- Auto-reconnect on disconnect

### Tech Stack

**Backend**
- Java 17+
- Quarkus (REST, WebSockets, CDI)
- Jackson (JSON serialization)
- JBoss Logging

**Frontend**
- Angular 18+
- TypeScript
- RxJS (Observables)
- CSS3 (Glassmorphism UI)

### Project Structure

```
/workspaces/env-sim
├── pom.xml
├── src/main/java/exemple/
│   ├── core/
│   │   ├── Engine.java          (Simulation engine)
│   │   ├── ActiveObject.java    (Base object)
│   │   ├── Scenario.java        (Root scenario)
│   │   └── ScheduledEvent.java  (Event model)
│   ├── model/
│   │   └── ActiveObjectTester.java
│   └── service/
│       └── Resources.java       (REST API)
└── src/main/webui/
    └── src/app/
        ├── app.component.*      (Main UI)
        └── services/
            └── app.service.ts   (API client)
```

### Quick Start

```bash
cd /workspaces/env-sim
mvn quarkus:dev
# Server runs on http://localhost:8080
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api` | API metadata |
| `POST` | `/api/engine/start` | Start simulation |
| `POST` | `/api/engine/stop` | Stop simulation |
| `POST` | `/api/engine/pause` | Pause simulation |
| `POST` | `/api/engine/resume` | Resume simulation |
| `GET` | `/api/engine/status` | Get engine status |
| `POST` | `/api/engine/timeScale?scale=X` | Set speed multiplier |
| `POST` | `/api/engine/runUntil?time=X` | Fast-forward to time |
| `GET` | `/api/engine/scenario` | Get current scenario |
| `POST` | `/api/engine/scenario` | Set new scenario (JSON) |
| `POST` | `/api/engine/backup` | Create scenario backup |
| `GET` | `/api/engine/backup` | Get backed-up scenario |
| `POST` | `/api/engine/restore` | Restore from backup |
| `GET` | `/api/engine/reset` | Reset engine |
| `WS` | `/ws/engine` | WebSocket live updates |

### Usage Example

1. **Start**
   - Backend: `mvn quarkus:dev`

2. **Create Scenario**
   - Click "Generate Scenario"
   - Optional : manually edit JSON in editor and click "Post Scenario" to load

3. **Run Simulation**
   - Click "Start"
   - Adjust speed with `0.5x`, `1x`, `2x`, `10x`, `100x` buttons
   - Jump forward with time buttons or fast-forward input

4. **Monitor Live**
   - Status updates in real-time via WebSocket
   - View simulation time, speed, and state

5. **Backup & Restore**
   - Click "Create Backup" to snapshot current scenario
   - Click "Stop" (auto-backup)
   - Click "Restore Backup" to reload

### Architecture

**Engine Loop**
```
while running:
  - Check for pause/stop
  - Process all events at current time
  - Advance simuTime
  - Sleep based on timeScale (or fast-forward)
```

**Scenario Hierarchy**
```
Scenario (root)
├── Child 1 (ActiveObject)
├── Child 2 (ActiveObject)
│   ├── Grandchild 1
│   └── Grandchild 2
└── Child 3
```

Each `ActiveObject` has:
- Unique ID (auto-generated or custom)
- `onInit()` - initialization hook
- `onProcess(time)` - processing hook
- `interval` - reschedule delay
- Children list

### Configuration

**Time Scale** (multiplier for real-time sleep)
- `0.5` = half speed
- `1.0` = real-time
- `2.0` = double speed
- `100` = nearly instant

**Run Until** (fast-forward target)
- Set target simulation time
- Engine runs as fast as possible until reached
- Then switches to real-time with configured timeScale

### Development

**Adding Custom ActiveObject**
```java
public class MyObject extends ActiveObject {
  @Override
  public void onInit() {
    // Initialize
  }

  @Override
  public void onProcess(long currentTime) {
    // Process and reschedule
    scheduleAt(currentTime + interval);
  }
}
```

**Logging**
- Backend: JBoss Logging (console output)
- Frontend: Browser console

### Known Limitations

- Single engine instance per application
- Scenario JSON must be valid before posting
- WebSocket requires browser support

### Future Enhancements

- Multiple parallel engine instances
- Scenario versioning & history
- Data export (CSV, charts)
- Performance profiling
- Custom event types
