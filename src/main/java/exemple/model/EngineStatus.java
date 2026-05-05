package exemple.model;

/**
 * Real-time engine status to be sent over WebSocket
 */
public class EngineStatus {
    public boolean running;
    public long simuTime;
    public double timeScale;
    public boolean paused;
    public long timestamp;

    public EngineStatus() {
    }

    public EngineStatus(boolean running, long simuTime, double timeScale, boolean paused) {
        this.running = running;
        this.simuTime = simuTime;
        this.timeScale = timeScale;
        this.paused = paused;
        this.timestamp = System.currentTimeMillis();
    }
}
