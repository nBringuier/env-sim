package exemple.core;

import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import exemple.model.Scenario;
import exemple.model.EngineStatus;
import jakarta.enterprise.context.ApplicationScoped;

@ApplicationScoped
public class Engine {
    private long simuTime = 0;
    private Scenario scenario; // Root scenario containing all objects as children
    private PriorityQueue<ScheduledEvent> eventQueue = new PriorityQueue<>();
    private ExecutorService executorService = Executors.newSingleThreadExecutor();
    private volatile boolean isRunning = false;
    private volatile boolean stopRequested = false;
    private volatile boolean paused = false;
    private double timeScale = 1.0; // 1.0 = real time, 0.5 = half speed, 2.0 = double speed
    private long runUntilTime = -1; // -1 = disabled, otherwise run as fast as possible until this time

    // State listeners
    private final List<Consumer<EngineStatus>> stateListeners = Collections.synchronizedList(new ArrayList<>());

    public long getSimuTime() {
        return this.simuTime;
    }

    /**
     * Add a listener to receive engine state updates
     */
    public void addStateListener(Consumer<EngineStatus> listener) {
        stateListeners.add(listener);
    }

    /**
     * Remove a listener from state updates
     */
    public void removeStateListener(Consumer<EngineStatus> listener) {
        stateListeners.remove(listener);
    }

    /**
     * Notify all listeners of state change
     */
    private void notifyStateChange() {
        EngineStatus status = new EngineStatus(isRunning, simuTime, timeScale, paused);
        for (Consumer<EngineStatus> listener : stateListeners) {
            try {
                listener.accept(status);
            } catch (Exception e) {
                // Log but don't throw to prevent listener issues from affecting engine
            }
        }
    }

    /**
     * Schedule a callback to be executed at a specific simulation time
     */
    public void schedule(long scheduleTime, Consumer<Long> process) {
        eventQueue.offer(new ScheduledEvent(scheduleTime, process));
    }

    /**
     * Set the root scenario (Scenario) for this simulation
     */
    public void setScenario(Scenario scenario) {
        if (isRunning) {
            throw new IllegalStateException("Cannot replace scenario while simulation is running");
        }
        this.scenario = scenario;
    }

    /**
     * Get the current scenario
     */
    public Scenario getScenario() {
        return scenario;
    }

    /**
     * Check if simulation is currently running
     */
    public boolean isRunning() {
        return isRunning;
    }

    /**
     * Set the time scale for real-time simulation
     * (1.0 = real time, 0.5 = half speed, 2.0 = double speed)
     */
    public void setTimeScale(double timeScale) {
        if (timeScale <= 0) {
            throw new IllegalArgumentException("Time scale must be positive");
        }
        this.timeScale = timeScale;
        notifyStateChange();
    }

    /**
     * Get the current time scale
     */
    public double getTimeScale() {
        return timeScale;
    }

    /**
     * Stop the running simulation
     */
    public void stop() {
        stopRequested = true;
        notifyStateChange();
    }

    /**
     * Check if simulation is paused
     */
    public boolean isPaused() {
        return paused;
    }

    /**
     * Pause the simulation
     */
    public void pause() {
        paused = true;
        notifyStateChange();
    }

    /**
     * Resume the simulation
     */
    public void resume() {
        paused = false;
        notifyStateChange();
    }

    /**
     * Set time to run simulation as fast as possible until this time,
     * then continue at real-time pace. Use -1 to disable.
     */
    public void setRunUntilTime(long runUntilTime) {
        this.runUntilTime = runUntilTime;
    }

    /**
     * Get the current runUntilTime setting (-1 means disabled)
     */
    public long getRunUntilTime() {
        return runUntilTime;
    }

    /**
     * Start the simulation in a separate thread:
     * 1. Initialize all registered objects
     * 2. Process events in chronological order
     * 3. Advance simulation time to each event
     */
    public void start() {
        if (isRunning) {
            throw new IllegalStateException("Simulation is already running");
        }
        if (scenario == null) {
            throw new IllegalStateException("No scenario has been set");
        }
        stopRequested = false;
        paused = false;
        notifyStateChange();
        executorService.submit(this::runSimulation);
    }

    /**
     * Internal method that runs the simulation (executed in executor thread)
     */
    private void runSimulation() {
        try {
            isRunning = true;
            notifyStateChange();
            // Initialize the scenario and all its children recursively
            scenario.init(this);

            // Process events in chronological order
            while (!eventQueue.isEmpty() && !stopRequested) {
                // Wait if simulation is paused
                while (paused && !stopRequested) {
                    try {
                        Thread.sleep(100);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }
                
                // Break if stop was requested while paused
                if (stopRequested) {
                    break;
                }
                
                ScheduledEvent event = eventQueue.poll();
                long previousTime = simuTime;
                long nextEventTime = event.time;
                
                // Sleep to simulate real-time if there's a gap between events
                // (skip sleep if we're still before runUntilTime)
                if (nextEventTime > previousTime && (runUntilTime < 0 || nextEventTime >= runUntilTime)) {
                    long sleepDuration = (long) ((nextEventTime - previousTime) / timeScale);
                    try {
                        Thread.sleep(sleepDuration);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
                
                // Disable runUntilTime once we've reached or passed it
                if (runUntilTime > 0 && nextEventTime >= runUntilTime) {
                    runUntilTime = -1;
                }
                
                // Check again if stop was requested during sleep
                if (stopRequested) {
                    break;
                }
                
                simuTime = event.time;
                notifyStateChange();
                
                // Execute the event
                event.callback.accept(simuTime);
                
                // Process any other events scheduled at the same simulation time
                while (!eventQueue.isEmpty() && eventQueue.peek().time == simuTime && !stopRequested) {
                    ScheduledEvent nextEvent = eventQueue.poll();
                    nextEvent.callback.accept(simuTime);
                }
            }
        } finally {
            isRunning = false;
            simuTime = 0;
            stopRequested = false;
            paused = false;
            runUntilTime = -1;
            eventQueue.clear();
            notifyStateChange();
        }
    }    
}
