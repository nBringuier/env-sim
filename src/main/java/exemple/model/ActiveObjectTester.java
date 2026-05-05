package exemple.model;

import org.jboss.logging.Logger;

import exemple.core.ActiveObject;

public class ActiveObjectTester extends ActiveObject {
    private static final Logger LOG = Logger.getLogger(ActiveObjectTester.class);

    @Override
    public void onInit() {
        LOG.info("ActiveObjectTester initialized with id: " + getId());
    }

    @Override
    public void onProcess(long currentTime) {
        LOG.info("Processing " + currentTime);
    }
}
