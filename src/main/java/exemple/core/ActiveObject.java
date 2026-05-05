package exemple.core;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

@JsonTypeInfo(use = JsonTypeInfo.Id.CLASS, include = JsonTypeInfo.As.PROPERTY, property = "@class")
public abstract class ActiveObject {
    private static final Map<String, ActiveObject> REGISTRY = new ConcurrentHashMap<>();

    protected int interval = 100;
    private String id = UUID.randomUUID().toString();
    private final List<ActiveObject> children = new ArrayList<>();

    protected ActiveObject() {
        REGISTRY.put(this.id, this);
    }

    public static ActiveObject getById(String id) {
        return REGISTRY.get(id);
    }

    public static void clearRegistry() {
        REGISTRY.clear();
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        if (id == null || id.isBlank()) {
            id = UUID.randomUUID().toString();
        }
        REGISTRY.remove(this.id);
        this.id = id;
        REGISTRY.put(this.id, this);
    }

    public int getInterval() {
        return interval;
    }

    public void setInterval(int interval) {
        this.interval = interval;
    }

    public void addChild(ActiveObject child) {
        children.add(child);
    }

    public List<ActiveObject> getChildren() {
        return Collections.unmodifiableList(children);
    }

    public void setChildren(List<ActiveObject> newChildren) {
        children.clear();
        if (newChildren != null) {
            children.addAll(newChildren);
        }
    }

    @JsonIgnore
    protected Engine engine;

    public abstract void onInit();

    public abstract void onProcess(long currentTime);

    protected final void init(Engine engine) {
        this.engine = engine;
        this.onInit();
        for (ActiveObject child : children) {
            child.init(engine);
        }
        this.engine.schedule(this.engine.getSimuTime() + this.interval, this::process);
    }

    protected final void process(long currentTime) {
        this.onProcess(currentTime);
        this.engine.schedule(currentTime + this.interval, this::process);
    }
}
