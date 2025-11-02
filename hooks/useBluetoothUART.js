// hooks/useBluetoothUART.js
import { useState, useRef, useCallback, useEffect } from 'react';
import { BleManager } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import * as SQLite from 'expo-sqlite';

// BLE UUIDs and Device Identifier
const DEVICE_NAME_PREFIX = 'CIRCUITPY1330';
const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // device → app (notify)
const RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // app → device (write)

const manager = new BleManager();
const db = SQLite.openDatabaseSync('readings.db'); // persistent local DB

export function useBluetoothUART() {
  const [isConnected, setIsConnected] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [connectionState, setConnectionState] = useState('idle'); // 'idle' | 'scanning' | 'connecting' | 'connected' | 'disconnected'
  const [sensorLogData, setSensorLogData] = useState([]);
  const [statusLogData, setStatusLogData] = useState([]);
  const [error, setError] = useState(null);

  // 🧮 Computed stats
  const [stats, setStats] = useState({
    totalExposure: 0,
    avgIntensity: 0,
    maxIntensity: 0,
  });
  // TODO: also add peak time once timestamps are read in

  const txCharRef = useRef(null);
  const rxCharRef = useRef(null);
  const deviceRef = useRef(null);
  const activeCommandRef = useRef(null);
  const lineBufferRef = useRef('');

  // ---- Helper: Base64 decode ----
  const b64ToUtf8 = (b64) => Buffer.from(b64, 'base64').toString('utf8');

  // ---- Initialize database ----
  useEffect(() => {
    db.execSync(`
      CREATE TABLE IF NOT EXISTS readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER,
        deviceTimestamp INTEGER,
        intensity REAL
      );
    `);
  }, []);

  // ---- Save reading ----
  const saveReading = useCallback((reading) => {
    db.runSync(
      'INSERT INTO readings (timestamp, deviceTimestamp, intensity) VALUES (?, ?, ?)',
      [reading.receivedAt, reading.deviceTimestamp, reading.intensity]
    );
  }, []);

  // ---- Recompute stats ----
  const updateStats = useCallback(() => {
    const result = db.getAllSync('SELECT intensity FROM readings');
    if (!result || result.length === 0) {
      setStats({ totalExposure: 0, avgIntensity: 0, maxIntensity: 0 });
      return;
    }

    const intensities = result.map((r) => r.intensity);
    const totalExposure = intensities.reduce((a, b) => a + b, 0);
    const avgIntensity = totalExposure / intensities.length;
    const maxIntensity = Math.max(...intensities);

    setStats({ totalExposure, avgIntensity, maxIntensity });
  }, []);

  // ---- Send text command ----
  const sendCommand = useCallback(async (cmd) => {
    // Prevent overlapping BLE writes
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
      console.log(`[BLE] Sent command: ${cmd}`);

     /* // timeout: auto-clear after 6s if no END or ERROR received
    if (cmd !== 'CLEAR') {
    setTimeout(() => {
        if (activeCommandRef.current === cmd) {
        console.warn(`[BLE] ⏳ ${cmd} timed out — resetting active command`);
        activeCommandRef.current = null;
        }
    }, 8000);
    }*/
   // timeout: auto-clear after 6s (2s for CLEAR)
    const timeoutMs = cmd === 'CLEAR' ? 2000 : 6000;
    setTimeout(() => {
    if (activeCommandRef.current === cmd) {
        console.warn(`[BLE] ⏳ ${cmd} timed out — resetting active command`);
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

      // Parse numeric readings
      if (cmd === 'GET' || looksLikeReading) {
        const readings = text
          .split('\n')
          .map((line) => {
            const [tsStr, intensityStr] = line.trim().split(',');
            const ts = Number(tsStr);
            const intensity = Number(intensityStr);

            if (isNaN(ts) || isNaN(intensity)) {
              console.warn('NaN values in line:', line.trim());
              return null;
            }

            return { deviceTimestamp: ts, intensity, receivedAt: now };
          })
          .filter(Boolean);

        if (readings.length > 0) {
          console.log('Parsed readings:', readings);
          setSensorLogData((prev) => [...prev, ...readings]);
          return;
        }
      }

      // Clear command if the device reports end or error
      /*
      if (
        text.toUpperCase().includes('END') ||
        text.toUpperCase().includes('ERROR') ||
        text.toUpperCase().includes('CLEARED')
        ) {
        console.log(`📨 ${cmd} complete — resetting active command`);
        activeCommandRef.current = null;

        // Only trigger CLEAR if we just finished a GET or HELLO command
        if (cmd && cmd !== 'CLEAR') {
            console.log('🧹 Sending CLEAR after', cmd);
            clearLog();
        }

        return;
        }
*/
        if (
        text.toUpperCase().includes('END') ||
        text.toUpperCase().includes('ERROR') ||
        text.toUpperCase().includes('CLEARED')
        ) {
        console.log(`${cmd} complete — resetting active command`);
        activeCommandRef.current = null;

        // Only trigger CLEAR if not already running one
        if (cmd && cmd !== 'CLEAR' && activeCommandRef.current !== 'CLEAR') {
            console.log('Sending CLEAR after', cmd);
            clearLog();
        }

        return;
        }


      // Log any other info messages
      const entry = { timestamp: now, command: cmd, text: text.trim() };
      setStatusLogData((prev) => [...prev, entry]);
    },
    [clearLog]
  );

  // ---- Connect & discover services ----
  const connectAndListen = useCallback(async () => {
  console.log('[BLE] Starting scan...');

  // Prevent overlapping scans or connections
  if (
    connectionState === 'connecting' ||
    connectionState === 'connected' ||
    connectionState === 'scanning'
  ) {
    console.log('[BLE] Already scanning or connecting — skipping new attempt');
    return;
  }

  setIsScanning(true);
  setConnectionState('scanning');
  setError(null);

  const state = await manager.state();
  console.log('[BLE] Bluetooth adapter state:', state);
  if (state !== 'PoweredOn') {
    console.warn('[BLE] Bluetooth not ready. Waiting...');
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

    console.log('[BLE] Found device:', device?.name || '(no name)', device?.id);

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
          console.log('[BLE] Attempting connection to', device.name || device.id);

          // Ensure no stale session exists
          await device.cancelConnection().catch(() => {});
          await new Promise((r) => setTimeout(r, 800));

          const connected = await device.connect({ autoConnect: true });
          await connected.discoverAllServicesAndCharacteristics();

          deviceRef.current = connected;
          setIsConnected(true);
          setConnectionState('connected');

          const services = await connected.services();
          console.log('[BLE] Services found:', services.map((s) => s.uuid));

          for (const s of services) {
            const chars = await connected.characteristicsForService(s.uuid);
            console.log(`[BLE] Service ${s.uuid} has characteristics:`, chars.map((c) => c.uuid));
            for (const c of chars) {
              if (c.uuid.toLowerCase() === TX_CHAR_UUID.toLowerCase())
                txCharRef.current = c;
              if (c.uuid.toLowerCase() === RX_CHAR_UUID.toLowerCase())
                rxCharRef.current = c;
            }
          }

          if (!txCharRef.current || !rxCharRef.current) {
            console.error('[BLE] Missing TX or RX characteristic');
            setConnectionState('disconnected');
            return;
          }

          // Send HELLO ONCE immediately after connecting
          console.log('[BLE] Sending initial HELLO');
          await sendCommand('HELLO');

          // Start listening for notifications
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

          // Handle disconnect — retry after delay
          connected.onDisconnected(() => {
            console.warn('[BLE] Disconnected');
            setIsConnected(false);
            setConnectionState('disconnected');
            txCharRef.current = null;
            rxCharRef.current = null;

            // Retry after 4s if not already reconnecting
            setTimeout(() => {
              if (
                connectionState !== 'connected' &&
                connectionState !== 'connecting'
              ) {
                console.log('[BLE] Retrying connection...');
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
      })(); // end async IIFE
    }
  });
}, [handleTX, connectionState]);

  // ---- Auto-trigger periodic GET (every 7s if idle) ----
  useEffect(() => {
    const interval = setInterval(() => {
      if (isConnected && !activeCommandRef.current) {
        sendCommand('GET');
      }
    }, 7000);
    return () => clearInterval(interval);
  }, [isConnected, sendCommand]);

  // ---- Cleanup ----
  useEffect(() => {
    return () => manager.destroy();
  }, []);

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
    connectAndListen,
    stats, // exported live stats
  };
}
