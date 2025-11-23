// hooks/useBluetoothUART.js
import { useState, useRef, useCallback, useEffect } from 'react';
import { BleManager } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import * as FileSystem from 'expo-file-system/legacy';

const DATA_FILE = FileSystem.documentDirectory + 'sensor_data.json';
const DAILY_STATS_FILE = FileSystem.documentDirectory + 'daily_stats.json';

const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

const manager = new BleManager();

export function useBluetoothUART() {
  const [isConnected, setIsConnected] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [connectionState, setConnectionState] = useState('idle');
  const [sensorLogData, setSensorLogData] = useState([]);
  const [statusLogData, setStatusLogData] = useState([]);
  const [error, setError] = useState(null);

  const [stats, setStats] = useState({
    totalExposure: 0,
    avgIntensity: 0,
    maxIntensity: 0,
    latestIntensity: 0,
    numberReadings: 0,
    peakTime: 0,
  });

  // ⭐ NEW: instant storage stats
  const [storageStats, setStorageStats] = useState({
    sizeKB: 0,
    totalReadings: 0,
  });

  // ⭐ NEW: Day / Week / Month reading counters
  const [timeRangeStats, setTimeRangeStats] = useState({
    readingsToday: 0,
    readingsWeek: 0,
    readingsMonth: 0,
  });

  const txCharRef = useRef(null);
  const rxCharRef = useRef(null);
  const activeCommandRef = useRef(null);
  const lineBufferRef = useRef('');
  const deviceRef = useRef(null);

  const b64ToUtf8 = (b64) => Buffer.from(b64, 'base64').toString('utf8');

  // ------------------------------
  // Load existing data on startup
  // ------------------------------
  useEffect(() => {
    (async () => {
      try {
        console.log("[INIT] Loading saved data...");
        const exists = await FileSystem.getInfoAsync(DATA_FILE);
        if (exists.exists) {
          const text = await FileSystem.readAsStringAsync(DATA_FILE);
          const saved = JSON.parse(text);

          if (Array.isArray(saved)) {
            setSensorLogData(saved);
            console.log(`[INIT] Loaded ${saved.length} legacy readings`);
          } else {
            if (saved.readings) {
              console.log(`[INIT] Loaded ${saved.readings.length} readings`);
              setSensorLogData(saved.readings);
            }
            if (saved.stats) setStats(saved.stats);
          }
        }
      } catch (err) {
        console.warn('[ERROR] Failed to load saved data:', err);
      }
    })();
  }, []);

  // ------------------------------
  // Recompute stats when data updates
  // ------------------------------
  useEffect(() => {
    if (!sensorLogData.length) {
      setStats({
        totalExposure: 0,
        avgIntensity: 0,
        maxIntensity: 0,
        latestIntensity: 0,
        numberReadings: 0,
        peakTime: 0,
      });
      console.log("[STATS] No readings — stats reset");
      return;
    }

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endOfDay = startOfDay + 86400000;

    const todayReadings = sensorLogData.filter(
      (r) => r.receivedAt >= startOfDay && r.receivedAt < endOfDay
    );

    if (!todayReadings.length) {
      setStats({
        totalExposure: 0,
        avgIntensity: 0,
        maxIntensity: 0,
        latestIntensity: 0,
        numberReadings: 0,
        peakTime: 0,
      });
      console.log("[STATS] No readings today — stats reset");
      return;
    }

    const intensities = todayReadings.map((r) => r.intensity);
    const totalExposure = intensities.reduce((a, b) => a + b, 0);
    const avgIntensity = totalExposure / intensities.length;
    const maxIntensity = Math.max(...intensities);
    const latestIntensity = intensities[intensities.length - 1];

    const maxReading = todayReadings.reduce(
      (max, r) => (r.intensity > max.intensity ? r : max),
      todayReadings[0]
    );

    const peakTime = maxReading.receivedAt; 

    const newStats = {
      totalExposure,
      avgIntensity,
      maxIntensity,
      latestIntensity,
      numberReadings: intensities.length,
      peakTime,
    };

    setStats(newStats);
    console.log(`[STATS] Updated: latest=${latestIntensity}, count=${intensities.length}`);

    // Save daily stats
    (async () => {
      try {
        const dateKey = now.toISOString().slice(0, 10);
        let dailyStats = {};

        const exists = await FileSystem.getInfoAsync(DAILY_STATS_FILE);
        if (exists.exists) {
          dailyStats = JSON.parse(await FileSystem.readAsStringAsync(DAILY_STATS_FILE));
        }

        dailyStats[dateKey] = {
          avgIntensity,
          totalExposure,
          maxIntensity,
          count: todayReadings.length,
          updatedAt: now.toISOString(),
        };

        await FileSystem.writeAsStringAsync(DAILY_STATS_FILE, JSON.stringify(dailyStats));
        console.log("[STATS] Daily stats saved");
      } catch (err) {
        console.warn('⚠️ Failed to save daily stats:', err);
      }
    })();
  }, [sensorLogData]);

  // ------------------------------
  // ⭐ NEW: Synchronous storage stats calculation
  // ------------------------------
  useEffect(() => {
    const json = JSON.stringify(sensorLogData);
    const sizeBytes = json.length;
    const sizeKB = sizeBytes / 1024;

    const updated = {
      sizeKB,
      totalReadings: sensorLogData.length,
    };

    setStorageStats(updated);
    console.log(
      `[STORAGE] size=${updated.sizeKB.toFixed(1)} KB, total=${updated.totalReadings} readings`
    );
  }, [sensorLogData]);

  // ⭐ NEW: compute readingsToday, readingsWeek, readingsMonth
  useEffect(() => {
    if (!sensorLogData.length) {
      setTimeRangeStats({
        readingsToday: 0,
        readingsWeek: 0,
        readingsMonth: 0,
      });
      return;
    }

    const now = new Date();

    // DAY
    const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endDay = startDay + 86400000;

    // WEEK
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(now.setDate(diff));
    const startWeek = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate()).getTime();
    const endWeek = startWeek + 7 * 86400000;

    // MONTH
    const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const endMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();

    const readingsToday = sensorLogData.filter(
      (r) => r.receivedAt >= startDay && r.receivedAt < endDay
    ).length;

    const readingsWeek = sensorLogData.filter(
      (r) => r.receivedAt >= startWeek && r.receivedAt < endWeek
    ).length;

    const readingsMonth = sensorLogData.filter(
      (r) => r.receivedAt >= startMonth && r.receivedAt < endMonth
    ).length;

    setTimeRangeStats({
      readingsToday,
      readingsWeek,
      readingsMonth,
    });

    console.log(
      `[TIME-STATS] today=${readingsToday}, week=${readingsWeek}, month=${readingsMonth}`
    );

  }, [sensorLogData]);


  // ------------------------------
  // Persist everything
  // ------------------------------
  useEffect(() => {
    (async () => {
      try {
        await FileSystem.writeAsStringAsync(
          DATA_FILE,
          JSON.stringify({ readings: sensorLogData, stats })
        );
        console.log("[SAVE] Sensor data persisted");
      } catch (err) {
        console.warn('[ERROR] Failed to save sensor data:', err);
      }
    })();
  }, [sensorLogData, stats]);

  // ------------------------------
  // Time filtering helpers
  // ------------------------------
  const getDataByDay = useCallback((date) => {
    const d = new Date(date);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const end = start + 86400000;
    return sensorLogData.filter((r) => r.receivedAt >= start && r.receivedAt < end);
  }, [sensorLogData]);

  const getDataByWeek = useCallback((date) => {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d.setDate(diff));
    const start = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate()).getTime();
    const end = start + 7 * 86400000;
    return sensorLogData.filter((r) => r.receivedAt >= start && r.receivedAt < end);
  }, [sensorLogData]);

  const getDataByMonth = useCallback((date) => {
    const d = new Date(date);
    const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    return sensorLogData.filter((r) => r.receivedAt >= start && r.receivedAt < end);
  }, [sensorLogData]);

  const getSortedReadings = useCallback(() => {
    return [...sensorLogData].sort((a, b) => b.receivedAt - a.receivedAt);
  }, [sensorLogData]);

  // ------------------------------
  // Clear storage
  // ------------------------------
  const clearSavedData = useCallback(async () => {
    try {
      await FileSystem.deleteAsync(DATA_FILE, { idempotent: true });
      setSensorLogData([]);
      setStats({});
      console.log('[DATA] All saved data cleared');
    } catch (err) {
      console.warn('[ERROR] Failed to clear data:', err);
    }
  }, []);

  // ------------------------------
  // Send BLE command
  // ------------------------------
  const sendCommand = useCallback(async (cmd) => {
    if (activeCommandRef.current) return;
    if (!rxCharRef.current) return;

    activeCommandRef.current = cmd;
    console.log(`[BLE] Sending command: ${cmd}`);

    try {
      const base64 = Buffer.from(cmd + '\n').toString('base64');
      await rxCharRef.current.writeWithResponse(base64);

      setTimeout(() => {
        if (activeCommandRef.current === cmd) {
          activeCommandRef.current = null;
          console.log(`[BLE] ${cmd} timed out`);
        }
      }, 6000);
    } catch (err) {
      console.error('[ERROR] BLE write error:', err);
      activeCommandRef.current = null;
    }
  }, []);

  const clearLog = useCallback(() => sendCommand('CLEAR'), [sendCommand]);

  // ------------------------------
  // Handle BLE incoming data
  // ------------------------------
  const handleTX = useCallback(
    (text) => {
      const now = Date.now();
      const cmd = activeCommandRef.current;

      const looksLikeReading = /^\d+,\d+/.test(text.trim());
      if (cmd === 'GET' || looksLikeReading) {
        const readings = text
          .split('\n')
          .map((line) => {
            const [ts, val] = line.trim().split(',');
            if (!ts || !val) return null;

            return {
              deviceTimestamp: Number(ts),
              intensity: Number(val),
              receivedAt: now,
            };
          })
          .filter(Boolean);

        if (readings.length) {
          console.log(`[DATA] Received ${readings.length} readings`);
          setSensorLogData((prev) => [...prev, ...readings]);
          return;
        }
      }

      if (/END|ERROR|CLEARED/i.test(text)) {
        console.log(`[BLE] Command ${cmd} complete`);
        activeCommandRef.current = null;
        if (cmd !== 'CLEAR') clearLog();
        return;
      }

      setStatusLogData((prev) => [
        ...prev,
        { timestamp: now, command: cmd, text: text.trim() },
      ]);
    },
    [clearLog]
  );

  // ------------------------------
  // Scan + connect
  // ------------------------------
  const connectAndListen = useCallback(async () => {
    console.log('[BLE] Scanning...');
    setIsScanning(true);
    setConnectionState('scanning');

    manager.startDeviceScan(null, null, (err, device) => {
      if (err) {
        console.error('[ERROR] Scan error:', err);
        setIsScanning(false);
        return;
      }

      if (!device) return;

      // Add these for debugging:
      //console.log(device.name, device.id, device.serviceUUIDs);

      // NEW matching logic
      const matches =
        (device.name && device.name.toLowerCase().includes("circuitpy")) ||
        device.id === "CIRCUITPY1330";


      if (!matches) return;

      console.log('[BLE] Device matched:', device.name || device.id);

      manager.stopDeviceScan();
      setIsScanning(false);
      setConnectionState('connecting');

      (async () => {
        try {
          console.log('[BLE] Connecting...');
          const connected = await device.connect();
          await connected.discoverAllServicesAndCharacteristics();

          console.log('[BLE] Connected!');
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

          sendCommand('HELLO');

          txCharRef.current.monitor((error, characteristic) => {
            if (error) {
              console.error('[ERROR] Notify error:', error);
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
            console.warn('[BLE] Disconnected!');
            setIsConnected(false);
            setConnectionState('disconnected');
          });
        } catch (e) {
          console.error('[ERROR] Connection error:', e);
        }
      })();
    });
  }, [handleTX, sendCommand]);

  // ------------------------------
  // Auto GET every 7 seconds
  // ------------------------------
  useEffect(() => {
    const t = setInterval(() => {
      if (isConnected && !activeCommandRef.current) {
        console.log('[BLE] Auto GET');
        sendCommand('GET');
      }
    }, 7000);
    return () => clearInterval(t);
  }, [isConnected, sendCommand]);

  // ------------------------------
  // Cleanup BLE
  // ------------------------------
  useEffect(() => () => manager.destroy(), []);

  // ------------------------------
  // Return API
  // ------------------------------
  return {
    isConnected,
    isScanning,
    connectionState,
    sensorLogData,
    statusLogData,
    error,

    stats,
    storageStats,   // ⭐ NEW — used like stats

    sendCommand,
    clearLog,
    clearSavedData,
    connectAndListen,

    getSortedReadings,
    getDataByDay,
    getDataByWeek,
    getDataByMonth,

    timeRangeStats
  };
}
