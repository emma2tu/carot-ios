// hooks/useBluetoothUART.js
import { useState, useRef, useCallback, useEffect } from 'react';
import { BleManager } from 'react-native-ble-plx';
import { Buffer } from 'buffer';

import * as FileSystem from 'expo-file-system/legacy';
//import * as SQLite from 'expo-sqlite';

const DATA_FILE = FileSystem.documentDirectory + 'sensor_data.json';

// BLE UUIDs and Device Identifier
const DEVICE_NAME_PREFIX = 'CIRCUITPY1330';
const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // device → app (notify)
const RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // app → device (write)

const manager = new BleManager();

export function useBluetoothUART() {
  const [isConnected, setIsConnected] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [connectionState, setConnectionState] = useState('idle');
  const [sensorLogData, setSensorLogData] = useState([]);
  const [statusLogData, setStatusLogData] = useState([]);
  const [error, setError] = useState(null);

  // 🧮 Computed stats (now persisted too)
  const [stats, setStats] = useState({
    totalExposure: 0,
    avgIntensity: 0,
    maxIntensity: 0,
  });

  const txCharRef = useRef(null);
  const rxCharRef = useRef(null);
  const deviceRef = useRef(null);
  const activeCommandRef = useRef(null);
  const lineBufferRef = useRef('');

  // ---- Helper: Base64 decode ----
  const b64ToUtf8 = (b64) => Buffer.from(b64, 'base64').toString('utf8');

  // ---- Load saved data (readings + stats) on startup ----
  useEffect(() => {
    (async () => {
      try {
        const exists = await FileSystem.getInfoAsync(DATA_FILE);
        if (exists.exists) {
          const text = await FileSystem.readAsStringAsync(DATA_FILE);
          const saved = JSON.parse(text);

          // Support both new + old format
          if (Array.isArray(saved)) {
            setSensorLogData(saved);
            console.log(`📂 Loaded ${saved.length} legacy readings`);
          } else {
            if (saved.readings) setSensorLogData(saved.readings);
            if (saved.stats) setStats(saved.stats);
            console.log(
              `📂 Loaded ${saved.readings?.length || 0} readings and stats from local file`
            );
          }
        }
      } catch (err) {
        console.warn('⚠️ Failed to load saved data:', err);
      }
    })();
  }, []);

  // ---- Compute stats every time readings update ----
  useEffect(() => {
    if (!sensorLogData || sensorLogData.length === 0) {
      setStats({ totalExposure: 0, avgIntensity: 0, maxIntensity: 0, latestIntensity: 0, });
      return;
    }

    const intensities = sensorLogData.map((r) => r.intensity);
    const totalExposure = intensities.reduce((a, b) => a + b, 0);
    const avgIntensity = totalExposure / intensities.length;
    const maxIntensity = Math.max(...intensities);
    const latestIntensity = intensities[intensities.length - 1];

    setStats({ totalExposure, avgIntensity, maxIntensity, latestIntensity });
  }, [sensorLogData]);

  // ---- Save readings + stats to file ----
  useEffect(() => {
    (async () => {
      try {
        const payload = JSON.stringify({
          readings: sensorLogData,
          stats,
        });
        await FileSystem.writeAsStringAsync(DATA_FILE, payload);
      } catch (err) {
        console.warn('⚠️ Failed to save sensor data:', err);
      }
    })();
  }, [sensorLogData, stats]);

  // ---- Optional: Clear saved data ----
  const clearSavedData = useCallback(async () => {
    try {
      await FileSystem.deleteAsync(DATA_FILE, { idempotent: true });
      setSensorLogData([]);
      setStats({ totalExposure: 0, avgIntensity: 0, maxIntensity: 0 });
      console.log('🗑️ Cleared saved sensor data + stats');
    } catch (err) {
      console.warn('⚠️ Failed to clear data:', err);
    }
  }, []);

  // ---- BLE send command ----
  const sendCommand = useCallback(async (cmd) => {
    if (activeCommandRef.current) {
      console.log(`[BLE] Skipping command ${cmd} – ${activeCommandRef.current} still running`);
      return;
    }

    if (!rxCharRef.current) {
      console.warn('[BLE] No RX characteristic ready');
      return;
    }

    activeCommandRef.current = cmd;
    console.log(`[BLE] Sending command: ${cmd}`);

    try {
      const base64 = Buffer.from(cmd + '\n', 'utf8').toString('base64');
      await rxCharRef.current.writeWithResponse(base64);

      const timeoutMs = cmd === 'CLEAR' ? 2000 : 6000;
      setTimeout(() => {
        if (activeCommandRef.current === cmd) {
          console.log(`[BLE] ${cmd} timed out — resetting active command`);
          activeCommandRef.current = null;
        }
      }, timeoutMs);
    } catch (err) {
      console.error(`[BLE] Failed to send ${cmd}:`, err);
      activeCommandRef.current = null;
    }
  }, []);

  const clearLog = useCallback(() => sendCommand('CLEAR'), [sendCommand]);

  // ---- Handle incoming TX data ----
  const handleTX = useCallback(
    (text) => {
      const cmd = activeCommandRef.current;
      const now = Date.now();
      const looksLikeReading = /^\d+,\d+/.test(text.trim());

      if (cmd === 'GET' || looksLikeReading) {
        const readings = text
          .split('\n')
          .map((line) => {
            const [tsStr, intensityStr] = line.trim().split(',');
            const ts = Number(tsStr);
            const intensity = Number(intensityStr);

            if (isNaN(ts) || isNaN(intensity)) return null;
            return { deviceTimestamp: ts, intensity, receivedAt: now };
          })
          .filter(Boolean);

        if (readings.length > 0) {
          console.log('Parsed readings:', readings);
          setSensorLogData((prev) => [...prev, ...readings]);
          return;
        }
      }

      if (
        text.toUpperCase().includes('END') ||
        text.toUpperCase().includes('ERROR') ||
        text.toUpperCase().includes('CLEARED')
      ) {
        console.log(`${cmd} complete — resetting active command`);
        activeCommandRef.current = null;

        if (cmd && cmd !== 'CLEAR' && activeCommandRef.current !== 'CLEAR') {
          console.log('Sending CLEAR after', cmd);
          clearLog();
        }
        return;
      }

      const entry = { timestamp: now, command: cmd, text: text.trim() };
      setStatusLogData((prev) => [...prev, entry]);
    },
    [clearLog]
  );

  // ---- Connect & discover services ----
  const connectAndListen = useCallback(async () => {
    console.log('[BLE] Starting scan...');
    if (['connecting', 'connected', 'scanning'].includes(connectionState)) {
      console.log('[BLE] Already scanning or connecting — skipping new attempt');
      return;
    }

    setIsScanning(true);
    setConnectionState('scanning');
    setError(null);

    const state = await manager.state();
    if (state !== 'PoweredOn') {
      console.warn('[BLE] Bluetooth not ready.');
      setConnectionState('idle');
      setIsScanning(false);
      return;
    }

    manager.startDeviceScan([SERVICE_UUID], null, (err, device) => {
      if (err) {
        console.error('[BLE] Scan error:', err);
        setError(err.message);
        setConnectionState('idle');
        setIsScanning(false);
        return;
      }

      if (!device) return;

      const matchesByService =
        device?.serviceUUIDs?.includes(SERVICE_UUID.toUpperCase()) ||
        device?.serviceUUIDs?.includes(SERVICE_UUID.toLowerCase());

      if (matchesByService) {
        console.log('[BLE] Matched target device:', device.name || device.id);
        manager.stopDeviceScan();
        setIsScanning(false);
        setConnectionState('connecting');

        (async () => {
          try {
            await device.cancelConnection().catch(() => {});
            await new Promise((r) => setTimeout(r, 800));

            const connected = await device.connect({ autoConnect: true });
            await connected.discoverAllServicesAndCharacteristics();

            deviceRef.current = connected;
            setIsConnected(true);
            setConnectionState('connected');

            const services = await connected.services();
            for (const s of services) {
              const chars = await connected.characteristicsForService(s.uuid);
              for (const c of chars) {
                if (c.uuid.toLowerCase() === TX_CHAR_UUID.toLowerCase()) txCharRef.current = c;
                if (c.uuid.toLowerCase() === RX_CHAR_UUID.toLowerCase()) rxCharRef.current = c;
              }
            }

            if (!txCharRef.current || !rxCharRef.current) {
              console.error('[BLE] Missing TX or RX characteristic');
              setConnectionState('disconnected');
              return;
            }

            console.log('[BLE] Sending initial HELLO');
            await sendCommand('HELLO');

            txCharRef.current.monitor((error, characteristic) => {
              if (error) {
                console.error('[BLE] Notify error:', error);
                return;
              }

              const text = b64ToUtf8(characteristic.value);
              lineBufferRef.current += text;

              let idx;
              while ((idx = lineBufferRef.current.indexOf('\n')) !== -1) {
                const line = lineBufferRef.current.slice(0, idx);
                lineBufferRef.current = lineBufferRef.current.slice(idx + 1);
                handleTX(line);
              }
            });

            connected.onDisconnected(() => {
              console.warn('[BLE] Disconnected');
              setIsConnected(false);
              setConnectionState('disconnected');
              txCharRef.current = null;
              rxCharRef.current = null;
              setTimeout(() => {
                if (!['connected', 'connecting'].includes(connectionState)) {
                  connectAndListen();
                }
              }, 4000);
            });
          } catch (e) {
            console.error('[BLE] Connection error:', e);
            setError(e.message);
            setConnectionState('disconnected');
            setIsScanning(false);
          }
        })();
      }
    });
  }, [handleTX, connectionState]);

  // ---- Auto-trigger periodic GET ----
  useEffect(() => {
    const interval = setInterval(() => {
      if (isConnected && !activeCommandRef.current) {
        sendCommand('GET');
      }
    }, 7000);
    return () => clearInterval(interval);
  }, [isConnected, sendCommand]);

  // ---- Cleanup ----
  useEffect(() => () => manager.destroy(), []);

  // ---- Return values ----
  return {
    isConnected,
    isScanning,
    connectionState,
    sensorLogData,
    statusLogData,
    error,
    sendCommand,
    clearLog,
    clearSavedData,
    connectAndListen,
    stats, // persisted + recomputed stats
  };
}
