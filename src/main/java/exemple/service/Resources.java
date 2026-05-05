package exemple.service;

import org.eclipse.microprofile.config.inject.ConfigProperty;

import exemple.core.Engine;
import exemple.model.ActiveObjectTester;
import exemple.model.Scenario;
import jakarta.inject.Inject;
import jakarta.json.Json;
import jakarta.json.JsonObject;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.MediaType;
import java.time.Instant;

@Path("/api")
public class Resources {
    @ConfigProperty(name = "quarkus.application.name", defaultValue = "undefined")
    String name;
    @ConfigProperty(name = "quarkus.application.version", defaultValue = "undefined")
    String version;

    @Inject
    Engine engine;

    @GET
    @Produces(MediaType.APPLICATION_JSON)
    public JsonObject get() {
        return Json.createObjectBuilder()
            .add("name", name)
            .add("version", version)
            .add("timestamp", Instant.now().toString())
            .build();
    }

    @POST
    @Path("/engine/start")
    @Produces(MediaType.APPLICATION_JSON)
    public JsonObject start() {
        engine.start();
        return Json.createObjectBuilder()
            .add("status", "simulation started in background")
            .add("running", engine.isRunning())
            .build();
    }

    @GET
    @Path("/engine/status")
    @Produces(MediaType.APPLICATION_JSON)
    public JsonObject getStatus() {
        return Json.createObjectBuilder()
            .add("running", engine.isRunning())
            .add("simuTime", engine.getSimuTime())
            .add("timeScale", engine.getTimeScale())
            .build();
    }

    @POST
    @Path("/engine/timeScale")
    @Produces(MediaType.APPLICATION_JSON)
    public JsonObject setTimeScale(@QueryParam("scale") double scale) {
        engine.setTimeScale(scale);
        return Json.createObjectBuilder()
            .add("timeScale", engine.getTimeScale())
            .build();
    }

    @POST
    @Path("/engine/stop")
    @Produces(MediaType.APPLICATION_JSON)
    public JsonObject stop() {
        engine.stop();
        return Json.createObjectBuilder()
            .add("status", "stop requested")
            .add("simuTime", engine.getSimuTime())
            .build();
    }

    @POST
    @Path("/engine/pause")
    @Produces(MediaType.APPLICATION_JSON)
    public JsonObject pause() {
        engine.pause();
        return Json.createObjectBuilder()
            .add("status", "paused")
            .add("simuTime", engine.getSimuTime())
            .build();
    }

    @POST
    @Path("/engine/resume")
    @Produces(MediaType.APPLICATION_JSON)
    public JsonObject resume() {
        engine.resume();
        return Json.createObjectBuilder()
            .add("status", "resumed")
            .add("simuTime", engine.getSimuTime())
            .build();
    }

    @POST
    @Path("/engine/runUntil")
    @Produces(MediaType.APPLICATION_JSON)
    public JsonObject runUntil(@QueryParam("time") long time) {
        engine.setRunUntilTime(time);
        return Json.createObjectBuilder()
            .add("status", "fast-forward enabled")
            .add("runUntilTime", time)
            .add("simuTime", engine.getSimuTime())
            .build();
    }

    @GET
    @Path("/engine/runUntil")
    @Produces(MediaType.APPLICATION_JSON)
    public JsonObject getRunUntilTime() {
        long runUntilTime = engine.getRunUntilTime();
        return Json.createObjectBuilder()
            .add("runUntilTime", runUntilTime)
            .add("enabled", runUntilTime > 0)
            .add("simuTime", engine.getSimuTime())
            .build();
    }

    @GET
    @Path("/engine/scenario")
    @Produces(MediaType.APPLICATION_JSON)
    public Scenario getScenario() {
        return engine.getScenario();
    }

    @POST
    @Path("/engine/scenario")
    @Consumes(MediaType.APPLICATION_JSON)
    @Produces(MediaType.APPLICATION_JSON)
    public Scenario setScenario(Scenario scenario) {
        if (engine.isRunning()) {
            throw new IllegalStateException("Cannot set scenario while simulation is running");
        }
        
        engine.setScenario(scenario);
        return scenario;
    }

    @GET
    @Path("/engine/generate-scenario")
    @Produces(MediaType.APPLICATION_JSON)
    public Scenario generateScenario() {
        if (engine.isRunning()) {
            throw new IllegalStateException("Cannot generate scenario while simulation is running");
        }

        Scenario scenario = new Scenario();
        engine.setScenario(scenario);

        ActiveObjectTester tester1 = new ActiveObjectTester();
        scenario.addChild(tester1);
        
        ActiveObjectTester tester2 = new ActiveObjectTester();
        scenario.addChild(tester2);

        return scenario;
    }
}
