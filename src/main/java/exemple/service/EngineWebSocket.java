package exemple.service;

import io.quarkus.websockets.next.OnOpen;
import io.quarkus.websockets.next.OnClose;
import io.quarkus.websockets.next.WebSocket;
import io.quarkus.websockets.next.WebSocketConnection;
import com.fasterxml.jackson.databind.ObjectMapper;
import exemple.core.Engine;
import exemple.model.EngineStatus;
import jakarta.inject.Inject;

/**
 * WebSocket endpoint for real-time engine state monitoring
 */
@WebSocket(path = "/ws/engine")
public class EngineWebSocket {
    @Inject
    Engine engine;

    private WebSocketConnection connection;
    private final ObjectMapper objectMapper = new ObjectMapper();

    @OnOpen
    public void onOpen(WebSocketConnection connection) {
        this.connection = connection;
        // Register this connection as a listener
        engine.addStateListener(this::sendStatus);
    }

    @OnClose
    public void onClose() {
        // Remove this connection from listeners
        engine.removeStateListener(this::sendStatus);
    }

    private void sendStatus(EngineStatus status) {
        try {
            if (connection != null && connection.isOpen()) {
                String json = objectMapper.writeValueAsString(status);
                connection.sendTextAndAwait(json);
            }
        } catch (Exception e) {
            // Silently ignore send errors
        }
    }
}
