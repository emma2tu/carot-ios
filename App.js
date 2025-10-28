// App.js
import { useEffect, useRef, useState, useCallback } from 'react';
import { ActivityIndicator, PermissionsAndroid, Platform, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import { BleManager } from 'react-native-ble-plx';            // ✅ correct package
import { Buffer } from 'buffer';
global.Buffer = global.Buffer || Buffer;

// =========== BLE IDENTIFIERS (UPDATE THESE) =============
// If you don't know UUIDs yet, start with DEVICE_NAME_PREFIX (advertised name)
// and watch the logs to see services/characteristics, then paste them here.
const DEVICE_NAME_PREFIX = 'BLUELIGHT'; // e.g., "BlueLight", "MyNecklace"
const SERVICE_UUID = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'; // TODO set to your service
const CHAR_UUID    = 'yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy';  // TODO set to your characteristic
// ========================================================

// BLE manager (singleton)
const manager = new BleManager();

// Ask Android 12+ runtime permissions for BLE
async function ensureBlePermissions() {
  if (Platform.OS !== 'android') return true;
  const needs = [];
  // On Android 12+ (API 31+), you need SCAN/CONNECT at runtime
  needs.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN);
  needs.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
  const res = await PermissionsAndroid.requestMultiple(needs);
  return Object.values(res).every(v => v === PermissionsAndroid.RESULTS.GRANTED);
}

// Decode Base64 notifications -> utf8 text lines
function b64ToUtf8(b64) {
  return global.Buffer.from(b64, 'base64').toString('utf8');
}

// ================== WEBVIEW HTML LOADING ==================
const localHtmlAsset = Asset.fromModule(require('./assets/build/index.html'));

export default function App() {
  const webref = useRef(null);
  const [html, setHtml] = useState(null);
  const [baseDir, setBaseDir] = useState(null);

  // Load local index.html (as string) + compute baseDir for ./assets/*
  useEffect(() => {
    let canceled = false;
    (async () => {
      await localHtmlAsset.downloadAsync();
      if (canceled) return;

      const uri = localHtmlAsset.localUri || localHtmlAsset.uri; // file:///...
      const dir = uri.replace(/[^/]+$/, '');
      setBaseDir(dir);

      try {
        const info = await FileSystem.getInfoAsync(uri);
        console.log('[WebView] HTML uri:', uri, 'exists?', info.exists, 'size:', info.size);
      } catch (e) {
        console.log('[WebView] getInfoAsync skipped:', e?.message);
      }

      let text = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 });

      // If your built HTML has absolute /assets/... paths, temporarily rewrite:
      // text = text.replaceAll('href="/assets/', 'href="./assets/');
      // text = text.replaceAll('src="/assets/',  'src="./assets/');

      setHtml(text);
    })().catch(e => {
      console.error('[WebView] Failed to prepare HTML asset:', e);
    });
    return () => { canceled = true; };
  }, []);

  // ===================== BLE EFFECT =======================
  const startBle = useCallback(async () => {
    const ok = await ensureBlePermissions();
    if (!ok) {
      console.warn('[BLE] permissions not granted');
      return;
    }

    // Start flow when BT is powered on
    const sub = manager.onStateChange((state) => {
      console.log('[BLE] state:', state);
      if (state === 'PoweredOn') {
        scanAndConnect();
        sub.remove();
      }
    }, true);

    let lineBuf = ''; // handle partial lines across notifications

    async function scanAndConnect() {
      console.log('[BLE] scanning…');
      manager.startDeviceScan(null, { allowDuplicates: false }, async (error, device) => {
        if (error) {
          console.error('[BLE] scan error', error);
          return;
        }
        if (!device) return;

        // Match device by advertised name; tweak to exact name if needed
        if (device.name && device.name.startsWith(DEVICE_NAME_PREFIX)) {
          console.log('[BLE] found', device.name, device.id);
          manager.stopDeviceScan();
          try {
            const connected = await device.connect({ autoConnect: true });
            console.log('[BLE] connected', connected.id);

            const ready = await connected.discoverAllServicesAndCharacteristics();
            const services = await ready.services();
            console.log('[BLE] services:', services.map(s => s.uuid));

            // If you don't yet know UUIDs, log chars to discover them:
            for (const s of services) {
              const chs = await ready.characteristicsForService(s.uuid);
              console.log('[BLE] chars for', s.uuid, chs.map(c => c.uuid));
            }

            // Subscribe to your text data characteristic
            ready.monitorCharacteristicForService(SERVICE_UUID, CHAR_UUID, (err, char) => {
              if (err) {
                console.error('[BLE] notify error', err);
                return;
              }
              if (!char?.value) return;

              // Convert BLE base64 payload to text and split into complete lines
              lineBuf += b64ToUtf8(char.value);
              let idx;
              while ((idx = lineBuf.indexOf('\n')) !== -1) {
                const line = lineBuf.slice(0, idx);
                lineBuf = lineBuf.slice(idx + 1);
                const trimmed = line.trim();
                if (!trimmed) continue;

                // Expecting "timestamp,value" per line
                const [timestamp, raw] = trimmed.split(',');
                const value = Number(raw);

                const payload = { type: 'bleData', timestamp, value };
                // → forward to WebView
                if (webref.current) {
                  webref.current.postMessage(JSON.stringify(payload));
                }
              }
            });

            // Optional: handle disconnects & restart scan
            connected.onDisconnected((err, dev) => {
              console.warn('[BLE] disconnected', dev?.id, err || '');
              // small backoff, then rescan
              setTimeout(scanAndConnect, 1500);
            });

          } catch (e) {
            console.error('[BLE] connect error', e);
            // Try scanning again
            manager.startDeviceScan(null, { allowDuplicates: false }, () => {});
          }
        }
      });
    }
  }, []);

  // Start BLE once; cleanup manager on unmount
  useEffect(() => {
    startBle();
    return () => {
      try { manager.destroy(); } catch {}
    };
  }, [startBle]);

  // Receive messages FROM the WebView (optional)
  const onMessage = useCallback((event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      console.log('[WEBVIEW MSG]', data);
      // e.g., handle {type:'ping'} or control commands from your page
    } catch {
      console.log('[WEBVIEW RAW]', event.nativeEvent.data);
    }
  }, []);

  if (!html || !baseDir) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: 'white' }}
      edges={['top', 'left', 'right']}
    >
      <WebView
        ref={webref}

        // Load HTML string + tell WebView which folder to use for relative ./assets/*
        source={{ html, baseUrl: baseDir }}

        // File access + directory permissions
        allowingReadAccessToURL={Platform.OS === 'android' ? 'file:///' : baseDir}
        allowFileAccess
        allowFileAccessFromFileURLs

        // Nice defaults
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        cacheEnabled={false} // flip to true for prod
        setSupportMultipleWindows={false}

        // Pipe console/info/warn/error to RN log
        injectedJavaScript={`
          (function() {
            const oldLog = console.log, oldErr = console.error, oldWarn = console.warn, oldInfo = console.info;
            function send(type, args){ window.ReactNativeWebView.postMessage(JSON.stringify({ type, args })); }
            console.log  = function(){ oldLog  && oldLog.apply(console, arguments);  send('log',  Array.from(arguments)); };
            console.warn = function(){ oldWarn && oldWarn.apply(console, arguments); send('warn', Array.from(arguments)); };
            console.error= function(){ oldErr  && oldErr.apply(console, arguments);  send('error',Array.from(arguments)); };
            console.info = function(){ (oldInfo||oldLog) && (oldInfo||oldLog).apply(console, arguments); send('info', Array.from(arguments)); };
            window.addEventListener('error', e => send('window.error', [e.message, e.filename, e.lineno]));
            window.addEventListener('unhandledrejection', e => send('unhandledrejection', [String(e.reason)]));
          })();
          true;
        `}
        onMessage={onMessage}
        onError={(e)=>console.log('onError', e.nativeEvent)}
        onHttpError={(e)=>console.log('onHttpError', e.nativeEvent)}
        onLoadEnd={(e)=>console.log('onLoadEnd', e.nativeEvent?.nativeEvent?.url)}
      />
    </SafeAreaView>
  );
}
