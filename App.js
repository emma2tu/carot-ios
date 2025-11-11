// App.js
import { useEffect, useRef, useState, useCallback } from 'react';
import { ActivityIndicator, Platform, View, Text } from 'react-native';  // 👈 added Text here
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';

import { useBluetoothUART } from './hooks/useBluetoothUART';

const localHtmlAsset = Asset.fromModule(require('./assets/build/index.html'));

export default function App() {
  const webref = useRef(null);
  const [html, setHtml] = useState(null);
  const [baseDir, setBaseDir] = useState(null);

  const {
    isConnected,
    isScanning,
    connectionState, // added
    sensorLogData,
    statusLogData,
    error,
    sendCommand,
    clearLog,
    connectAndListen,
    stats,
  } = useBluetoothUART();

  useEffect(() => {
    if (webref.current) {
      webref.current.postMessage(JSON.stringify({
        type: 'bleConnection',
        isConnected
      }));
    }
  }, [isConnected]);

  // 🔹 Load WebView HTML once
  useEffect(() => {
    (async () => {
      try{
        await localHtmlAsset.downloadAsync();
        const uri = localHtmlAsset.localUri || localHtmlAsset.uri;
        const dir = uri.replace(/[^/]+$/, '');
        setBaseDir(dir);
        const text = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.UTF8,
        });

        setHtml(text);
      } catch (err) {
        console.error('error loading html:',err);
      }
      

    })();
  }, []);

  // Send initial HELLO + start periodic GET if connected
  useEffect(() => {
    if (isConnected) {
      //sendCommand('HELLO');
      const id = setInterval(() => sendCommand('GET'), 3000);
      return () => clearInterval(id);
    }
  }, [isConnected, sendCommand]);

  // Forward BLE readings to WebView
  useEffect(() => {
    if (!webref.current || sensorLogData.length === 0) return;

      // Compute stats from your readings
      const totalExposure = sensorLogData.reduce((sum, r) => sum + r.intensity, 0);
      const avgIntensity = totalExposure / sensorLogData.length;
      const maxIntensity = Math.max(...sensorLogData.map(r => r.intensity));
      const currentIntensity = sensorLogData[sensorLogData.length - 1];

      // post to WebView
      webref.current.postMessage(JSON.stringify({
        type: 'bleData',
        payload: {
          totalExposure,
          avgIntensity,
          maxIntensity,
          currentIntensity,
        },
      })
    );

    sensorLogData.forEach((entry) => {
      webref.current.postMessage(JSON.stringify({ type: 'bleData', entry }));
    });

  }, [sensorLogData]);

  // Notify WebView when BLE connection status changes
  useEffect(() => {
    if (webref.current) {
      webref.current.postMessage(
        JSON.stringify({ type: 'bleConnection', isConnected })
      );
    }
  }, [isConnected]);

  // Handle connection requests from WebView
  const onMessage = useCallback(
    (event) => {
      try {
        const data = JSON.parse(event.nativeEvent.data);

        // Try reconnecting the BLE if it's not already connected
        if (!isConnected) {
          console.log('[BLE] Attempting to connect...');
          // this triggers your scan + connect flow
          connectAndListen && connectAndListen();
        } /*
        else {
          console.log('[BLE] Already connected — sending HELLO');
          sendCommand('HELLO');
        }*/
      } catch (err) {
        console.error('[WebView] Failed to handle message:', err);
      }
    },
    [isConnected, connectAndListen, sendCommand]
  );

  // 🔹 Show loading indicator while HTML loads
  if (!html || !baseDir) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator />
        </View>
      </SafeAreaView>
    );
  }

  // 🔹 Render WebView with a connection status banner
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: 'white' }}>
      {/* Connection status bar */}

      <View style={{ padding: 10, backgroundColor: '#f8f8f8' }}>
        {isScanning ? (
          <Text style={{ fontSize: 16, fontWeight: '500', color: '#007bff' }}>
            Scanning for Bluetooth devices...
          </Text>
        ) : isConnected ? (
          <Text style={{ fontSize: 16, fontWeight: '500', color: 'green' }}>
            Connected to device
          </Text>
        ) : (
          <Text style={{ fontSize: 16, fontWeight: '500', color: 'red' }}>
            Not connected
          </Text>
        )}
      </View>

      {/* Web content */}
      <WebView
        ref={webref}
        source={{ html, baseUrl: baseDir }}
        allowingReadAccessToURL={Platform.OS === 'android' ? 'file:///' : baseDir}
        allowFileAccess
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled

        injectedJavaScript={`
          (function() {
            const oldLog = console.log;
            console.log = function(...args) {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'log', args }));
              oldLog(...args);
            };
          })();
          true;
        `}

        // use the named onMessage callback defined above
        onMessage={onMessage}

      />
    </SafeAreaView>
  );
}
