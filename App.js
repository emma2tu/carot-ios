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
    connectionState,
    sensorLogData,
    statusLogData,
    error,

    stats,
    storageStats,    // ⭐ UPDATED: instant storage metrics

    sendCommand,
    clearLog,
    clearSavedData,
    connectAndListen,

    getSortedReadings,
    getDataByDay,
    getDataByWeek,
    getDataByMonth,

    timeRangeStats
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

  // send persisted stats whenever they update
  useEffect(() => {
    if (!webref.current) return;
    webref.current.postMessage(
      JSON.stringify({ type: 'updateStats', payload: stats,
        latestIntensity: sensorLogData[sensorLogData.length - 1]?.intensity ?? null,
       })
    );
  }, [stats]);

  // send storage stats
  useEffect(() => {
    if (!webref.current) return;
    webref.current.postMessage(
      JSON.stringify({ type: 'storageStats', payload: storageStats,
       })
    );
  }, [storageStats]);

  // send time range stats
  useEffect(() => {
    if (!webref.current) return;
    webref.current.postMessage(
      JSON.stringify({ type: 'timeRangeStats', payload: timeRangeStats,
       })
    );
  }, [timeRangeStats]);


  useEffect(() => {
    if (!webref.current) return;
    
    webref.current.postMessage(
      JSON.stringify({ type: 'sensorData', payload: sensorLogData,
        })
    );
  }, [sensorLogData]);


  // Notify WebView when BLE connection status changes
  useEffect(() => {
    if (webref.current) {
      webref.current.postMessage(
        JSON.stringify({ type: 'bleConnection', isConnected })
      );
    }
  }, [isConnected]);

/*
  // Handle connection requests from WebView
  const onMessage = useCallback(
    (event) => {
      try {
        const data = JSON.parse(event.nativeEvent.data);

        // 🔹 Handle logs from browser console
        if (data.type === "log") {
          console.log("[WEBVIEW LOG]:", ...data.args);
          return;
        }

        // Try reconnecting the BLE if it's not already connected
        if (!isConnected) {
          console.log('[BLE] Attempting to connect...');
          // this triggers your scan + connect flow
          connectAndListen && connectAndListen();
        } 
        /*
        else {
          console.log('[BLE] Already connected — sending HELLO');
          sendCommand('HELLO');
        }

      } catch (err) {
        console.error('[WebView] Failed to handle message:', err);
      }
    },
    [isConnected, connectAndListen, sendCommand]
  );
  */

  const onMessage = useCallback(
  (event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      // 💡 Ignore console.log messages coming from WebView
      if (data.type === 'log') return;

      // 💡 Only connect when WebView explicitly asks
      if (data.type === 'connectBluetooth') {
        console.log('[BLE] connectBluetooth request from WebView');
        connectAndListen && connectAndListen();
        return;
      }

    } catch (err) {
      console.error('[WebView] Failed to handle message:', err);
    }
  },
  [connectAndListen]
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


      {/* Web content */}
      <WebView
        ref={webref}
        source={{ html, baseUrl: baseDir }}
        allowingReadAccessToURL={Platform.OS === 'android' ? 'file:///' : baseDir}
        allowFileAccess
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled

        
        injectedJavaScriptBeforeContentLoaded={`
          (function() {
            const oldLog = console.log;
            console.log = function(...args) {
              try {
                window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'log', args }));
              } catch (e) {}
              oldLog.apply(null, args);
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
