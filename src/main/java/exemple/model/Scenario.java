package exemple.model;

import exemple.core.ActiveObject;

public class Scenario extends ActiveObject {
    @Override
    public void onInit() {
        // No additional initialization for the scenario root
    }

    @Override
    public void onProcess(long currentTime) {
        // Scenario root does not process events itself
    }
}
