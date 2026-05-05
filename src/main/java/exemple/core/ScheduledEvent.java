package exemple.core;

import java.util.function.Consumer;

/**
 * Internal class to represent a scheduled event
 */
class ScheduledEvent implements Comparable<ScheduledEvent> {
    long time;
    Consumer<Long> callback;

    ScheduledEvent(long time, Consumer<Long> callback) {
        this.time = time;
        this.callback = callback;
    }

    @Override
    public int compareTo(ScheduledEvent other) {
        return Long.compare(this.time, other.time);
    }
}