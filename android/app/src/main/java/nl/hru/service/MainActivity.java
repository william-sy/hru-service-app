package nl.hru.service;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeviceHttpPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
