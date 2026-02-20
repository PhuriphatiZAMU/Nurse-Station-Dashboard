import React, { useState, useEffect, useRef, useCallback } from 'react';
import { initializeApp } from "firebase/app";
import { getDatabase, ref, onValue, update } from "firebase/database";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";
import { getAnalytics, logEvent } from "firebase/analytics";
import { getFirestore, collection, addDoc, query, orderBy, limit, onSnapshot, serverTimestamp } from "firebase/firestore";
import { SpeedInsights } from '@vercel/speed-insights/react';
import {
  Activity,
  ShieldAlert,
  Volume2,
  VolumeX,
  Settings,
  LayoutDashboard,
  Cpu,
  Unplug,
  Wifi,
  WifiOff,
  AlertTriangle,
  Save,
  X,
  ExternalLink,
  Camera,
  Monitor,
  Link2,
  CheckCircle,
  Stethoscope,
  XCircle,
  ScrollText,
  Filter,
  Trash2
} from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// --- Utility for Tailwind Classes ---
function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// --- Firebase Configuration ---
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_DATABASE_URL || "https://preserving-fall-detector-default-rtdb.firebaseio.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const db = getDatabase(app);   // Realtime Database (real-time UI feed)
const fsdb = getFirestore(app); // Firestore (permanent log storage)
const auth = getAuth(app);

// --- Central Log Writer ---
// Writes to RTDB hospital_system/logs/{timestamp} AND Firebase Analytics
const LOG_TYPES = {
  FALL_DETECTED: { label: 'Fall Detected', color: 'red' },
  ACKNOWLEDGED: { label: 'Alarm Acknowledged', color: 'amber' },
  RESOLVED: { label: 'Assistance Complete', color: 'green' },
  DEVICE_CHANGE: { label: 'Device Status Change', color: 'blue' },
  MUTE: { label: 'Alarm Muted', color: 'slate' },
  UNMUTE: { label: 'Alarm Unmuted', color: 'slate' },
  SYSTEM: { label: 'System', color: 'slate' },
};

async function writeLog(type, message, meta = {}) {
  try {
    const ts = Date.now();
    const entry = {
      type,
      message,
      meta,
      timestamp: ts,
      isoTime: new Date(ts).toISOString(),
      createdAt: serverTimestamp(),  // Firestore server-side timestamp
    };

    // 1. Firestore — permanent log collection (persistent audit trail)
    await addDoc(collection(fsdb, 'logs'), entry);

    // 2. RTDB — real-time UI feed (timestamp as key, auto-sorted)
    await update(ref(db, `hospital_system/logs/${ts}`), entry);

    // 3. Firebase Analytics — event tracking
    logEvent(analytics, type.toLowerCase(), { message, ...meta });
  } catch (e) {
    console.warn('writeLog failed:', e);
  }
}
// --- Audio System (Mobile Optimized) ---
class AlarmSound {
  constructor() {
    this.audioCtx = null;
    this.intervalId = null;
    this.isPlaying = false;
    this.isUnlocked = false;
    this.alarmBuffer = null;
    this.fallbackAudio = null;
    this._onUnlock = null;
  }

  init(onUnlockCallback) {
    this._onUnlock = onUnlockCallback;
    this._createFallbackAudio();
  }

  async _unlock() {
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioCtx.state === 'suspended') {
        try { await this.audioCtx.resume(); } catch { /* ignore */ }
      }

      // If still suspended/closed, abort silent tone to avoid console errors
      if (this.audioCtx.state === 'suspended' || this.audioCtx.state === 'closed') {
        return;
      }

      // Silent unlock tone
      const silentOsc = this.audioCtx.createOscillator();
      const silentGain = this.audioCtx.createGain();
      silentGain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      silentOsc.connect(silentGain);
      silentGain.connect(this.audioCtx.destination);
      silentOsc.start();
      silentOsc.stop(this.audioCtx.currentTime + 0.01);

      this._generateAlarmBuffer();

      if (this.fallbackAudio) {
        try {
          this.fallbackAudio.volume = 0;
          await this.fallbackAudio.play();
          this.fallbackAudio.pause();
          this.fallbackAudio.currentTime = 0;
          this.fallbackAudio.volume = 1;
        } catch { /* ignore */ }
      }

      this.isUnlocked = true;
      if (this._onUnlock) this._onUnlock(true);
    } catch (e) {
      console.error('Audio unlock failed:', e);
    }
  }

  _generateAlarmBuffer() {
    if (!this.audioCtx) return;
    const sampleRate = this.audioCtx.sampleRate;
    const duration = 2.0; // 2 seconds loop
    const length = sampleRate * duration;
    const buffer = this.audioCtx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    // ISO 60601-1-8 High Priority Alarm Pattern
    // Burst of 10 pulses: 3 fast, 2 slow, 3 fast, 2 slow... simplified to 5-pulse burst
    // Frequency: 960Hz (B5) mixed with harmonics

    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      // Simple Siren: 960Hz <-> 770Hz every 0.25s
      const freq = (t % 0.5 < 0.25) ? 960 : 770;

      // Square wave for piercing sound
      const wave = Math.sin(2 * Math.PI * freq * t) > 0 ? 0.9 : -0.9;

      // Envelope: 10ms attack/decay to prevent clicking
      let envelope = 1;
      const pulsePos = t % 0.25;
      if (pulsePos < 0.01) envelope = pulsePos / 0.01;
      if (pulsePos > 0.24) envelope = (0.25 - pulsePos) / 0.01;

      data[i] = wave * envelope;
    }
    this.alarmBuffer = buffer;
  }

  _createFallbackAudio() {
    try {
      const sampleRate = 22050;
      const duration = 1.8;
      const numSamples = Math.floor(sampleRate * duration);
      const dataSize = numSamples * 2;
      const headerSize = 44;
      const buffer = new ArrayBuffer(headerSize + dataSize);
      const view = new DataView(buffer);

      const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
      writeStr(0, 'RIFF');
      view.setUint32(4, 36 + dataSize, true);
      writeStr(8, 'WAVE');
      writeStr(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeStr(36, 'data');
      view.setUint32(40, dataSize, true);

      for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        const cyclePos = t % 0.4;
        const freq = cyclePos < 0.2 ? 880 : 660;
        const wave = Math.sin(2 * Math.PI * freq * t) > 0 ? 0.6 : -0.6;
        let envelope = 1;
        const beepPos = t % 0.2;
        if (beepPos < 0.005) envelope = beepPos / 0.005;
        if (beepPos > 0.18) envelope = (0.2 - beepPos) / 0.02;
        if (t > 1.6) envelope *= (duration - t) / 0.2;
        const sample = Math.max(-1, Math.min(1, wave * envelope));
        view.setInt16(headerSize + i * 2, sample * 32767, true);
      }

      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      this.fallbackAudio = new Audio('data:audio/wav;base64,' + btoa(binary));
      this.fallbackAudio.loop = true;
    } catch { /* ignore */ }
  }

  play() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    if (this.audioCtx && this.alarmBuffer && this.isUnlocked) {
      this._playWebAudio();
    } else if (this.fallbackAudio) {
      this._playFallback();
    }
  }

  _playWebAudio() {
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => { });
    }
    const playOnce = () => {
      if (!this.isPlaying || !this.audioCtx) return;
      const s = this.audioCtx.createBufferSource();
      s.buffer = this.alarmBuffer;
      s.connect(this.audioCtx.destination);
      s.start(0);
    };
    playOnce();
    this.intervalId = setInterval(playOnce, 2000);
  }

  _playFallback() {
    try {
      this.fallbackAudio.currentTime = 0;
      this.fallbackAudio.volume = 1;
      this.fallbackAudio.play().catch(() => { });
    } catch { /* ignore */ }
  }

  stop() {
    this.isPlaying = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.fallbackAudio) {
      this.fallbackAudio.pause();
      this.fallbackAudio.currentTime = 0;
    }
  }

  dispose() {
    this.stop();
    if (this.audioCtx) this.audioCtx.close().catch(() => { });
  }
}

// --- Main App Component ---
export default function App() {
  const [activeTab, setActiveTab] = useState('monitor'); // 'monitor' | 'devices' | 'logs'
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);

  // Data State
  const [wardsData, setWardsData] = useState({});
  const [devices, setDevices] = useState({});
  const [sensorData, setSensorData] = useState({});
  const [editingDevice, setEditingDevice] = useState(null);

  // Logs State
  const [logs, setLogs] = useState([]);
  const [logFilter, setLogFilter] = useState('ALL'); // 'ALL' | type keys

  const handleSaveConfig = async (deviceId, roomId, patientName) => {
    try {
      if (!roomId) return alert("Room ID cannot be empty");

      const normalizedRoom = roomId.trim().toLowerCase().startsWith('room_')
        ? roomId.trim()
        : `room_${roomId.trim()}`;

      const updates = {};
      // Update Device Config so board knows where it is
      updates[`hospital_system/devices/${deviceId}/config/room_id`] = normalizedRoom;
      updates[`hospital_system/devices/${deviceId}/config/patient_name`] = patientName;
      updates[`hospital_system/devices/${deviceId}/config/assigned_room`] = normalizedRoom;

      await update(ref(db), updates);
      console.log(`Updated ${deviceId} -> ${normalizedRoom} : ${patientName}`);
      setEditingDevice(null);
    } catch (err) {
      console.error("Config Save Error:", err);
      alert("Failed to update: " + err.message);
    }
  };

  // Alert State
  const [activeAlert, setActiveAlert] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [alarmAcknowledged, setAlarmAcknowledged] = useState(false);
  const [audioReady, setAudioReady] = useState(false);

  // Track unacked count to re-trigger alarm on new events
  const lastUnackedCount = useRef(0);

  // Modal State
  const [viewingRoom, setViewingRoom] = useState(null); // { wardKey, roomKey, ...roomData }
  const [resolvingRoom, setResolvingRoom] = useState(null); // { wardKey, roomKey }

  const alarmRef = useRef(null);

  // Initialize Audio & Notifications
  useEffect(() => {
    alarmRef.current = new AlarmSound();
    alarmRef.current.init((unlocked) => {
      setAudioReady(unlocked);
      // Ask for notification permission on interaction
      if (unlocked && "Notification" in window && Notification.permission !== "granted") {
        Notification.requestPermission();
      }
    });
    return () => alarmRef.current?.dispose();
  }, []);

  // Firebase Auth & Data Subscription
  useEffect(() => {
    let unsubscribeWards = null;
    let unsubscribeDevices = null;

    const setupListeners = () => {
      // 1. One Listener to Rule Them All (Wards -> Rooms -> Devices)
      const wardsRef = ref(db, 'hospital_system/wards');
      unsubscribeWards = onValue(wardsRef, (snapshot) => {
        const data = snapshot.val() || {};
        setWardsData(data); // Store all wards
        setConnected(true);
        setError(null);
        setLoading(false);
      }, (err) => {
        console.error("Ward Listen Error:", err);
        setError("Connection lost: " + err.message);
        setConnected(false);
      });

      // 2. Listen for Unassigned Devices (Global Discovery for Auto-Detect)
      const devicesRef = ref(db, 'hospital_system/devices');
      unsubscribeDevices = onValue(devicesRef, (snapshot) => {
        const data = snapshot.val() || {};
        setDevices(data);
      });
    };

    // Authenticate (Anonymous)
    // Authenticate (Anonymous)
    const isPlaceholderKey = !firebaseConfig.apiKey || firebaseConfig.apiKey === 'your-api-key-here';

    if (isPlaceholderKey) {
      console.warn("โ ๏ธ No valid API Key found. Skipping Auth and attempting direct DB connection.");
      // Try to listen without auth (works if rules are .read: true)
      setupListeners();

      if (!connected) {
        setError("Setup Required: Valid Web API Key missing.");
      }
      setLoading(false);
    } else {
      signInAnonymously(auth)
        .then(() => {
          console.log("๐”ฅ Firebase Auth: Signed in anonymously");
          setupListeners();
        })
        .catch((err) => {
          console.error("Auth Error:", err);
          // If auth fails, we still try to listen in case rules allow public read
          setupListeners();

          if (err.code === 'auth/api-key-not-valid') {
            setError("Invalid API Key: Please update .env with the Web API Key from Firebase Console.");
          } else if (err.code === 'auth/configuration-not-found') {
            setError("Setup Required: Enable 'Anonymous' sign-in provider in Firebase Console > Authentication > Sign-in method.");
          } else {
            setError(`Authentication failed: ${err.message}`);
          }
          setLoading(false);
        });
    }

    return () => {
      if (unsubscribeWards) unsubscribeWards();
      if (unsubscribeDevices) unsubscribeDevices();
    };
  }, []); // Run once on mount

  // --- Logic Helper: Get Room Status (Generic for Future Devices) ---
  const getRoomLogic = (room) => {
    const devices = room.devices || {};
    const devValues = Object.values(devices);

    let isFall = false;
    let isOffline = true;
    let hasDevices = devValues.length > 0;

    // Robust Legacy Fall Check (Handle String/Boolean)
    let legacyFall = room.live_status?.fall_detected;
    if (String(legacyFall).toLowerCase() === 'true') legacyFall = true;
    else if (String(legacyFall).toLowerCase() === 'false') legacyFall = false;
    else legacyFall = !!legacyFall;

    // Robust Ack Check (Handle String/Boolean)
    let isAck = room.live_status?.acknowledged;
    if (String(isAck).toLowerCase() === 'true') isAck = true;
    else isAck = false;

    if (hasDevices) {
      // --- Online Check ---
      // Significant = devices with IP, CAM model, or known monitor role
      const significantDevices = devValues.filter(d =>
        d.ip || d.model?.toLowerCase().includes('cam') || d.model?.toLowerCase().includes('monitor')
      );

      if (significantDevices.length > 0) {
        // A device is online if:
        //   a) Status/status is 'online' or 'normal'
        //   b) OR it has an IP but NO Status field at all (presence in DB = alive)
        const someOnline = significantDevices.some(d => {
          const s = (d.Status || d.status || '').toLowerCase();
          if (s === 'online' || s === 'normal') return true;
          // Device reported to DB but has no Status key โ’ treat as online
          if (!d.Status && !d.status) return true;
          return false;
        });
        if (someOnline) isOffline = false;
      } else {
        // Only sensors โ’ assume online
        isOffline = false;
      }

      // --- Fall Detection: Read from `Status` field ONLY ---
      // `Detection: "Yes"` = camera sees a person (presence), NOT a fall signal.
      // `Status` is the authoritative alarm field from the ESP32:
      //   "Normal"  โ’ No alarm
      //   Anything else (e.g. "Fall Down", "Emergency", "Fall") โ’ ALARM
      const deviceFall = devValues.some(d => {
        const s = (d.Status || d.status || '').toLowerCase();

        // No Status reported โ’ not a fall from this device
        if (!s) return false;

        // "Normal" and "Online" are the only non-alarm states
        if (s === 'normal' || s === 'online') return false;

        // Any other Status value means alarm state
        return true;
      });
      isFall = deviceFall || legacyFall;
    } else {
      isFall = legacyFall;
    }

    return {
      isFall,
      isOffline,
      isAck,
      hasDevices
    };
  };

  // Global Alert Logic (Multi-Ward)
  useEffect(() => {
    let unackedCount = 0;
    let anyFall = false;
    let alertRoomName = "";

    Object.entries(wardsData).forEach(([wardName, ward]) => {
      Object.entries(ward).forEach(([roomKey, room]) => {
        const { isFall, isAck } = getRoomLogic(room);
        if (isFall) {
          anyFall = true;
          if (!isAck) {
            unackedCount++;
            alertRoomName = `${wardName.replace('ward_', '')} - ${roomKey.replace('room_', '')}`;
          }
        }
      });
    });

    // Re-Trigger Alarm if new unacked event appears
    if (unackedCount > lastUnackedCount.current) {
      setAlarmAcknowledged(false);
    }
    lastUnackedCount.current = unackedCount;

    setActiveAlert(anyFall);

    if (unackedCount > 0 && !alarmAcknowledged) {
      if ("Notification" in window && Notification.permission === "granted") {
        try { new Notification("FALL DETECTED!", { body: alertRoomName }); } catch (e) { }
      }
    }
  }, [wardsData, activeAlert, alarmAcknowledged]);

  // --- Log New Fall Events to RTDB (tracks first-occurrence only) ---
  const prevFallRooms = useRef(new Set());
  useEffect(() => {
    Object.entries(wardsData).forEach(([wardKey, ward]) => {
      Object.entries(ward).forEach(([roomKey, room]) => {
        const { isFall } = getRoomLogic(room);
        const key = `${wardKey}/${roomKey}`;
        if (isFall && !prevFallRooms.current.has(key)) {
          writeLog('FALL_DETECTED', `Fall detected in ${wardKey} / ${roomKey}`, { wardKey, roomKey });
          prevFallRooms.current.add(key);
        } else if (!isFall) {
          prevFallRooms.current.delete(key);
        }
      });
    });
  }, [wardsData]);

  // --- Subscribe to Logs from Firestore (permanent history) ---
  useEffect(() => {
    const logsQuery = query(
      collection(fsdb, 'logs'),
      orderBy('timestamp', 'desc'),
      limit(200)
    );
    const unsub = onSnapshot(logsQuery, (snap) => {
      const arr = snap.docs.map(d => d.data());
      setLogs(arr);
    });
    return () => unsub();
  }, []);

  // Handle Audio Alarm
  // NOTE: recompute fall state inline โ€” do NOT rely on stale `activeAlert` state.
  useEffect(() => {
    let anyUnacked = false;
    Object.values(wardsData).forEach(ward => {
      Object.values(ward).forEach(room => {
        const { isFall, isAck } = getRoomLogic(room);
        if (isFall && !isAck) anyUnacked = true;
      });
    });

    if (anyUnacked && !isMuted && !alarmAcknowledged) {
      alarmRef.current?.play();
    } else {
      alarmRef.current?.stop();
    }
  }, [wardsData, isMuted, alarmAcknowledged]);

  const handleAcknowledge = async (wardKey, roomKey) => {
    try {
      const roomRef = ref(db, `hospital_system/wards/${wardKey}/${roomKey}/live_status`);
      await update(roomRef, { acknowledged: true });
      setAlarmAcknowledged(true);
      writeLog('ACKNOWLEDGED', `Alarm acknowledged in ${wardKey} / ${roomKey}`, { wardKey, roomKey });
    } catch (err) { console.error(err); }
  };

  const handleAcknowledgeAll = async () => {
    const updates = {};
    const rooms = [];
    Object.entries(wardsData).forEach(([wardKey, ward]) => {
      Object.entries(ward).forEach(([roomKey, room]) => {
        const { isFall, isAck } = getRoomLogic(room);
        if (isFall && !isAck) {
          updates[`hospital_system/wards/${wardKey}/${roomKey}/live_status/acknowledged`] = true;
          rooms.push(`${wardKey}/${roomKey}`);
        }
      });
    });
    if (Object.keys(updates).length > 0) {
      await update(ref(db), updates);
      setAlarmAcknowledged(true);
      writeLog('ACKNOWLEDGED', `All alarms acknowledged`, { rooms });
    }
  };

  const confirmResolution = async () => {
    if (!resolvingRoom) return;
    const { wardKey, roomKey } = resolvingRoom;
    try {
      const roomRef = ref(db, `hospital_system/wards/${wardKey}/${roomKey}`);
      await update(roomRef, {
        "live_status/fall_detected": false,
        "live_status/acknowledged": false,
        "devices/Pir_Motion_Sensor/val": 0,
        "devices/Pir_Motion_Sensor/object_present": "No",
        "devices/ESP32_S3_CAM/Status": "Normal",
        "devices/ESP32_S3_CAM/Detection": "No"
      });
      writeLog('RESOLVED', `Patient assistance complete in ${wardKey} / ${roomKey}`, { wardKey, roomKey });
      setResolvingRoom(null);
    } catch (err) {
      console.error("Resolution Error:", err);
      alert("Failed to resolve: " + err.message);
    }
  };

  useEffect(() => {
    const unlockAudio = () => {
      if (alarmRef.current) {
        alarmRef.current._unlock().then(() => {
          setAudioReady(true);
          // Ask for notification permission silently on first click
          if ("Notification" in window && Notification.permission !== "granted") {
            Notification.requestPermission();
          }
        });
      }
    };

    const unlockHandler = () => {
      unlockAudio();
      document.removeEventListener('click', unlockHandler);
      document.removeEventListener('keydown', unlockHandler);
      document.removeEventListener('touchend', unlockHandler);
    };

    document.addEventListener('click', unlockHandler, { once: true });
    document.addEventListener('keydown', unlockHandler, { once: true });
    document.addEventListener('touchend', unlockHandler, { once: true });

    return () => {
      document.removeEventListener('click', unlockHandler);
      document.removeEventListener('keydown', unlockHandler);
      document.removeEventListener('touchend', unlockHandler);
    };
  }, []);

  // Mute toggle with logging
  const handleToggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    writeLog(next ? 'MUTE' : 'UNMUTE', next ? 'Alarm sound muted by nurse' : 'Alarm sound unmuted by nurse');
  };

  if (loading) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-slate-950 text-white">
        <Activity className="h-12 w-12 animate-spin text-blue-500 mb-4" />
        <p className="text-lg font-semibold animate-pulse">Connecting to IoT Nurse Station...</p>
      </div>
    );
  }

  return (
    <div className={cn(
      "min-h-screen transition-colors duration-500 font-sans p-4 md:p-8",
      activeAlert ? "bg-gradient-to-br from-red-950 to-black" : "bg-gradient-to-br from-slate-950 to-slate-900"
    )}>

      {/* --- Header --- */}
      <header className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-4 mb-8">
        <div className="flex items-center gap-4">
          <div className={cn(
            "p-3 rounded-2xl transition-all shadow-lg",
            activeAlert ? "bg-red-600 animate-pulse shadow-red-500/40" : "bg-blue-600 shadow-blue-500/30"
          )}>
            <ShieldAlert size={32} className="text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-white to-slate-400">
              Nurse Station Monitor
            </h1>
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <span className={cn("w-2 h-2 rounded-full", connected ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" : "bg-red-500")} />
              {connected ? "System Online" : "Disconnected"}
            </div>
          </div>
        </div>

        <div className="flex gap-3 bg-slate-900/50 p-2 rounded-xl backdrop-blur-md border border-slate-800">
          <button
            onClick={() => setActiveTab('monitor')}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
              activeTab === 'monitor' ? "bg-blue-600 text-white shadow-lg" : "text-slate-400 hover:bg-slate-800"
            )}
          >
            <LayoutDashboard size={18} />
            Monitoring
          </button>
          <button
            onClick={() => setActiveTab('devices')}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
              activeTab === 'devices' ? "bg-blue-600 text-white shadow-lg" : "text-slate-400 hover:bg-slate-800"
            )}
          >
            <Cpu size={18} />
            Device Manager
          </button>
          <button
            onClick={() => setActiveTab('logs')}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all relative",
              activeTab === 'logs' ? "bg-blue-600 text-white shadow-lg" : "text-slate-400 hover:bg-slate-800"
            )}
          >
            <ScrollText size={18} />
            History
            {logs.filter(l => l.type === 'FALL_DETECTED').length > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full text-[10px] flex items-center justify-center text-white font-bold">
                {logs.filter(l => l.type === 'FALL_DETECTED').length > 9 ? '9+' : logs.filter(l => l.type === 'FALL_DETECTED').length}
              </span>
            )}
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleToggleMute}
            className={cn(
              "relative p-2.5 rounded-lg transition-colors border border-transparent",
              isMuted ? "bg-red-500/10 text-red-500 border-red-500/20" : "text-slate-400 hover:bg-slate-800 hover:text-white",
              !audioReady && "opacity-50"
            )}
            title={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
            {!audioReady && <span className="absolute -top-1 -right-1 flex h-3 w-3"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75" /><span className="relative inline-flex rounded-full h-3 w-3 bg-yellow-500" /></span>}
          </button>
          <div className="hidden md:block px-4 py-2 bg-slate-800 rounded-lg text-sm text-slate-300 font-medium">
            {new Date().toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' })}
          </div>
        </div>
      </header>

      {/* --- Error Banner --- */}
      {/* --- Error Banner --- */}
      {error && (
        <div className="max-w-7xl mx-auto mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-200 flex flex-col md:flex-row items-center justify-between gap-4 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <AlertTriangle size={24} className="text-red-500 shrink-0" />
            <span className="font-medium">{error}</span>
          </div>
          {(error.includes("API Key") || error.includes("Setup Required")) && (
            <a
              href="https://console.firebase.google.com/project/_/settings/general/"
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg font-bold text-sm transition-colors shadow-lg whitespace-nowrap"
            >
              Get API Key โ’
            </a>
          )}
        </div>
      )}

      {/* --- Content Area --- */}
      <main className="max-w-7xl mx-auto">

        {/* TAB: MONITORING */}
        {activeTab === 'monitor' && (
          <div className="space-y-6">
            {activeAlert && (
              (() => {
                let hasUnacked = false;
                Object.values(wardsData).forEach(ward =>
                  Object.values(ward).forEach(room => {
                    const { isFall, isAck } = getRoomLogic(room);
                    if (isFall && !isAck) hasUnacked = true;
                  })
                );

                return (
                  <div className={cn(
                    "p-6 rounded-2xl shadow-2xl flex flex-wrap items-center justify-between gap-4 text-white transition-all duration-500",
                    hasUnacked
                      ? "bg-gradient-to-r from-red-600 to-red-800 animate-bounce"
                      : "bg-gradient-to-r from-amber-600 to-amber-800 animate-pulse"
                  )}>
                    <div className="flex items-center gap-4">
                      {hasUnacked ? <ShieldAlert size={40} className="animate-pulse" /> : <Stethoscope size={40} className="animate-bounce" />}
                      <div>
                        <h2 className="text-2xl font-bold">{hasUnacked ? "EMERGENCY ALERT" : "ASSISTANCE DIRECTED"}</h2>
                        <p className={hasUnacked ? "text-red-100" : "text-amber-100"}>
                          {hasUnacked ? "Fall detected! Immediate attention required." : "Staff notified. Waiting for resolution confirmation."}
                        </p>
                      </div>
                    </div>
                    {hasUnacked ? (
                      <div className="flex gap-2">
                        {!audioReady && (
                          <button
                            onClick={() => alarmRef.current?._unlock()}
                            className="px-4 py-3 bg-amber-400 text-black font-bold rounded-xl shadow-lg hover:bg-amber-300 animate-pulse flex items-center gap-2"
                          >
                            <Volume2 size={20} /> ENABLE SOUND
                          </button>
                        )}
                        <button
                          onClick={handleAcknowledgeAll}
                          className="px-6 py-3 bg-white text-red-600 font-bold rounded-xl shadow-lg hover:bg-gray-100 transition transform hover:scale-105 flex items-center gap-2"
                        >
                          <CheckCircle size={20} /> ACKNOWLEDGE ALL
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 bg-black/20 px-4 py-2 rounded-lg border border-white/20">
                        <Activity size={18} className="animate-spin" />
                        <span className="font-bold">Team Responding...</span>
                      </div>
                    )}
                  </div>
                );
              })()
            )}

            {/* Iterate Wards */}
            {Object.entries(wardsData).map(([wardKey, wardRooms]) => (
              <div key={wardKey} className="space-y-4 pt-4">
                <h2 className="text-xl font-bold text-slate-400 border-b border-slate-800 pb-2 mb-6 flex items-center gap-2">
                  <LayoutDashboard size={20} />
                  {wardKey.replace('ward_', 'Ward ').toUpperCase()}
                  <span className="text-xs bg-slate-800 px-2 py-1 rounded-full text-slate-500">{Object.keys(wardRooms).length} Rooms</span>
                </h2>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {Object.entries(wardRooms).map(([roomKey, room]) => {
                    const { isFall, isAck, isOffline } = getRoomLogic(room);
                    const isEmergency = isFall && !isAck;
                    const isWaiting = isFall && isAck;

                    return (
                      <div key={roomKey} className={cn(
                        "relative overflow-hidden rounded-3xl border transition-all duration-300 group",
                        isEmergency
                          ? "bg-red-900/40 border-red-500 shadow-[0_0_30px_rgba(220,38,38,0.3)] scale-[1.02]"
                          : isWaiting
                            ? "bg-amber-900/40 border-amber-500 shadow-[0_0_20px_rgba(245,158,11,0.2)]"
                            : "bg-slate-900/40 border-slate-800 hover:border-slate-700 hover:-translate-y-1 hover:shadow-xl backdrop-blur-sm"
                      )}>
                        {/* Card Header */}
                        <div className="p-6 border-b border-white/5 flex justify-between items-start">
                          <div className="flex items-center gap-4">
                            <div className={cn(
                              "w-14 h-14 rounded-2xl flex items-center justify-center text-white font-bold text-xl shadow-lg transition-transform group-hover:scale-110",
                              isEmergency ? "bg-red-600 animate-bounce" : isWaiting ? "bg-amber-500 animate-pulse" : "bg-slate-800"
                            )}>
                              {roomKey.replace('room_', '')}
                            </div>

                            <div>
                              <h3 className="text-lg font-bold text-slate-100">
                                {room.patient_info?.name || room.config?.patient_name || `Room ${roomKey.replace('room_', '')}`}
                              </h3>
                              <div className="flex flex-col">
                                <p className={cn(
                                  "text-xs font-bold uppercase tracking-wider flex items-center gap-1.5",
                                  isOffline ? "text-slate-500" : "text-green-500"
                                )}>
                                  <span className={cn("w-1.5 h-1.5 rounded-full", isOffline ? "bg-slate-600" : "bg-green-500")} />
                                  {isOffline ? "OFFLINE" : "ACTIVE MONITORING"}
                                </p>
                                {/* Show Last Update if available from new path */}
                                {room.fall_detection?.last_update && (
                                  <p className="text-[10px] text-slate-500 mt-0.5">
                                    Updated: {room.fall_detection.last_update}
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                          {isEmergency && <ShieldAlert className="text-red-500 animate-pulse" size={28} />}
                          {isWaiting && <Stethoscope className="text-amber-500 animate-pulse" size={28} />}
                        </div>

                        {/* Card Body & Actions */}
                        <div className="p-6 space-y-4">
                          <div className="flex justify-between items-center text-sm text-slate-400">
                            <span>Status</span>
                            <span className={cn(
                              "font-bold text-sm px-3 py-1 rounded-full flex items-center gap-2",
                              isEmergency
                                ? "bg-red-500/20 text-red-500 animate-pulse"
                                : isWaiting
                                  ? "bg-amber-500/20 text-amber-500"
                                  : "bg-green-500/20 text-green-500"
                            )}>
                              {isEmergency && <AlertTriangle size={14} />}
                              {isWaiting && <Stethoscope size={14} />}
                              {isEmergency ? "๐จ FALL DETECTED" : isWaiting ? "WAITING FOR HELP" : "Normal"}
                            </span>
                          </div>

                          <div className="pt-2">
                            {isEmergency ? (
                              <button
                                onClick={() => handleAcknowledge(wardKey, roomKey)}
                                className="w-full py-3 bg-red-600 hover:bg-red-500 text-white font-bold rounded-xl shadow-lg shadow-red-900/50 flex items-center justify-center gap-2 transition-all active:scale-95 hover:scale-[1.02]"
                              >
                                <CheckCircle size={18} /> Acknowledge Alarm
                              </button>
                            ) : isWaiting ? (
                              <button
                                onClick={() => setResolvingRoom({ wardKey, roomKey })}
                                className="w-full py-3 bg-amber-500 hover:bg-amber-400 text-slate-900 font-bold rounded-xl shadow-lg shadow-amber-900/50 flex items-center justify-center gap-2 transition-all active:scale-95 hover:scale-[1.02]"
                              >
                                <XCircle size={18} /> Confirm Assistance Complete
                              </button>
                            ) : (
                              <button
                                onClick={() => setViewingRoom({ wardKey, roomKey, ...room })}
                                className="w-full py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-xl flex items-center justify-center gap-2 transition-all border border-slate-700 hover:border-slate-600"
                              >
                                Details
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )
        }

        {/* --- Devices Tab: Pairing & Management --- */}
        {
          activeTab === 'devices' && (() => {
            // Flatten devices for statistics (Ward Aware)
            const allDevices = [];
            Object.entries(wardsData).forEach(([wardKey, rooms]) => {
              Object.entries(rooms).forEach(([roomKey, room]) => {
                const devs = room.devices || {};
                Object.entries(devs).forEach(([devName, devData]) => {
                  if (devName === 'Pir_Motion_Sensor') return;
                  allDevices.push({ ward: wardKey, room: roomKey, name: devName, ...devData });
                });
              });
            });

            // Filter Unassigned Devices for Auto-Discovery Section
            const unassignedList = Object.entries(devices).filter(([key, dev]) => {
              if (key === 'Pir_Motion_Sensor') return false;
              return !dev.config?.assigned_room || dev.config.assigned_room === 'unassigned';
            });

            return (
              <div className="space-y-6 animate-in fade-in zoom-in duration-300">
                {/* Header Stats */}
                <div className="bg-slate-900/50 backdrop-blur-md rounded-2xl border border-slate-800 p-6 shadow-xl">
                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
                    <div>
                      <h2 className="text-xl font-bold text-white flex items-center gap-2">
                        <Cpu className="text-blue-400" />
                        ๐” System Hardware Status
                      </h2>
                      <p className="text-slate-400 text-sm mt-1">
                        Real-time status of all devices across all wards.
                      </p>
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      <span className="bg-blue-500/10 text-blue-400 px-3 py-1.5 rounded-full text-xs font-bold border border-blue-500/20">
                        {Object.keys(wardsData).length} Wards Active
                      </span>
                      <span className="bg-emerald-500/10 text-emerald-400 px-3 py-1.5 rounded-full text-xs font-bold border border-emerald-500/20">
                        {allDevices.length} Devices Total
                      </span>
                    </div>
                  </div>
                </div>

                {/* Unassigned Devices (Auto-Discovery) */}
                {unassignedList.length > 0 && (
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-6 mb-6">
                    <h3 className="text-amber-400 font-bold flex items-center gap-2 mb-4">
                      <AlertTriangle size={20} /> New Devices Detected ({unassignedList.length})
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {unassignedList.map(([id, dev]) => (
                        <div key={id} className="bg-slate-900/80 p-4 rounded-xl border border-slate-700/50 flex flex-col justify-between gap-3">
                          <div>
                            <div className="flex justify-between items-start">
                              <h4 className="font-mono font-bold text-slate-200 truncate" title={id}>{id}</h4>
                              <span className="text-[10px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded uppercase tracking-wider">New</span>
                            </div>
                            <p className="text-xs text-slate-500 mt-1">{dev.type || 'Unknown Type'}</p>
                          </div>

                          <div className="flex gap-2">
                            <input
                              id={`assign-room-${id}`}
                              placeholder="Room (e.g. 301)"
                              className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:border-amber-500 outline-none"
                            />
                            <button
                              onClick={() => handleSaveConfig(id, document.getElementById(`assign-room-${id}`).value, '')}
                              className="bg-amber-600 hover:bg-amber-500 text-white px-3 py-2 rounded-lg text-xs font-bold transition-colors"
                            >
                              Assign
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Device List by Ward/Room */}
                {Object.entries(wardsData).map(([wardKey, rooms]) => (
                  <div key={wardKey} className="space-y-4">
                    <h3 className="text-lg font-bold text-slate-500 uppercase tracking-widest pl-2 border-l-4 border-slate-700">
                      {wardKey.replace('ward_', 'Ward ')}
                    </h3>
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                      {Object.entries(rooms).map(([roomKey, room]) => {
                        const devList = Object.entries(room.devices || {}).filter(([n]) => n !== 'Pir_Motion_Sensor');
                        const hasDevices = devList.length > 0;

                        return (
                          <div key={roomKey} className="bg-slate-900/40 rounded-2xl border border-slate-700/50 overflow-hidden">
                            <div className="px-5 py-3 bg-slate-800/60 border-b border-slate-700/50 flex justify-between items-center">
                              <h3 className="font-bold text-slate-200 flex items-center gap-2">
                                <span className="w-8 h-8 rounded-lg bg-slate-700 flex items-center justify-center text-xs">
                                  {roomKey.replace('room_', '')}
                                </span>
                                Device Bundle
                              </h3>
                              <span className={cn("text-xs font-mono px-2 py-1 rounded bg-black/20 text-slate-400", hasDevices ? "opacity-100" : "opacity-50")}>
                                {devList.length} Units
                              </span>
                            </div>

                            <div className="p-4 space-y-3">
                              {hasDevices ? (
                                devList.map(([devName, devData]) => {
                                  // Dynamic Icon Logic
                                  let Icon = Cpu;
                                  let colorClass = "text-slate-400";
                                  const nameUpper = devName.toUpperCase();
                                  if (nameUpper.includes('CAM')) { Icon = Camera; colorClass = "text-blue-400"; }
                                  else if (nameUpper.includes('MONITOR')) { Icon = Monitor; colorClass = "text-emerald-400"; }
                                  else if (nameUpper.includes('MOTION') || nameUpper.includes('RADAR')) { Icon = Activity; colorClass = "text-amber-400"; }

                                  // Status
                                  const status = devData.Status || devData.status || "Unknown";
                                  const isOnline = status === 'Online' || status === 'Normal';

                                  return (
                                    <div key={devName} className="flex items-center justify-between p-3 bg-slate-950/30 rounded-xl border border-white/5">
                                      <div className="flex items-center gap-3">
                                        <div className={cn("p-2 rounded-lg bg-slate-900", colorClass)}>
                                          <Icon size={18} />
                                        </div>
                                        <div>
                                          <p className="text-sm font-bold text-slate-200">{devName}</p>
                                          <div className="flex gap-2 text-[10px] text-slate-500 font-mono mt-0.5">
                                            {devData.ip && <span>IP: {devData.ip}</span>}
                                            {devData.mac && <span className="hidden sm:inline">MAC: {devData.mac}</span>}
                                          </div>
                                        </div>
                                      </div>
                                      <div className="text-right">
                                        <span className={cn(
                                          "text-xs font-bold px-2 py-1 rounded-full",
                                          (status === 'Fall Down' || status === 'Emergency') ? "bg-red-500/20 text-red-400" :
                                            isOnline ? "bg-emerald-500/10 text-emerald-400" : "bg-slate-700 text-slate-400"
                                        )}>
                                          {status}
                                        </span>
                                        {devData.Detection && (
                                          <p className="text-[10px] text-slate-500 mt-1">
                                            Detect: {devData.Detection}
                                          </p>
                                        )}
                                        {devData.val !== undefined && (
                                          <p className="text-[10px] text-slate-500 mt-1">
                                            Val: {devData.val}
                                          </p>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })
                              ) : (
                                <div className="text-center py-6 text-slate-500 text-sm italic">
                                  No devices configured.
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()
        }





        {/* --- History / Logs Tab --- */}
        {activeTab === 'logs' && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
              <div>
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  <ScrollText className="text-blue-400" size={22} />
                  Event History
                </h2>
                <p className="text-sm text-slate-500 mt-0.5">{logs.length} events recorded</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {['ALL', ...Object.keys(LOG_TYPES)].map(f => (
                  <button
                    key={f}
                    onClick={() => setLogFilter(f)}
                    className={cn(
                      "px-3 py-1.5 text-xs font-bold rounded-full border transition-all",
                      logFilter === f
                        ? "bg-blue-600 border-blue-500 text-white"
                        : "bg-slate-800/60 border-slate-700 text-slate-400 hover:border-slate-500"
                    )}
                  >
                    {f === 'ALL' ? 'All Events' : (LOG_TYPES[f]?.label || f)}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              {(() => {
                const filtered = logFilter === 'ALL' ? logs : logs.filter(l => l.type === logFilter);
                if (filtered.length === 0) {
                  return (
                    <div className="flex flex-col items-center justify-center py-20 text-slate-600">
                      <ScrollText size={48} className="mb-4 opacity-30" />
                      <p className="text-lg font-semibold">No events recorded yet</p>
                      <p className="text-sm mt-1">Events appear when falls, acknowledgments, or resolutions occur.</p>
                    </div>
                  );
                }
                return filtered.map((log, i) => {
                  const cfg = LOG_TYPES[log.type] || LOG_TYPES.SYSTEM;
                  const colorMap = { red: 'border-red-500/30 bg-red-500/5 hover:bg-red-500/10', amber: 'border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10', green: 'border-green-500/30 bg-green-500/5 hover:bg-green-500/10', blue: 'border-blue-500/30 bg-blue-500/5 hover:bg-blue-500/10', slate: 'border-slate-700/50 bg-slate-800/30 hover:bg-slate-800/60' };
                  const badgeMap = { red: 'bg-red-500/20 text-red-400', amber: 'bg-amber-500/20 text-amber-400', green: 'bg-green-500/20 text-green-400', blue: 'bg-blue-500/20 text-blue-400', slate: 'bg-slate-700 text-slate-400' };
                  const d = new Date(log.timestamp);
                  const timeStr = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                  const dateStr = d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
                  return (
                    <div key={String(log.timestamp) + i} className={cn("flex items-start gap-4 p-4 rounded-xl border transition-colors", colorMap[cfg.color] || colorMap.slate)}>
                      <div className={cn("shrink-0 p-2 rounded-lg", badgeMap[cfg.color] || badgeMap.slate)}>
                        {log.type === 'FALL_DETECTED' && <ShieldAlert size={18} />}
                        {log.type === 'ACKNOWLEDGED' && <CheckCircle size={18} />}
                        {log.type === 'RESOLVED' && <Stethoscope size={18} />}
                        {log.type === 'DEVICE_CHANGE' && <Wifi size={18} />}
                        {log.type === 'MUTE' && <VolumeX size={18} />}
                        {log.type === 'UNMUTE' && <Volume2 size={18} />}
                        {log.type === 'SYSTEM' && <Activity size={18} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <span className={cn("text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full", badgeMap[cfg.color] || badgeMap.slate)}>{cfg.label}</span>
                          {log.meta?.wardKey && <span className="text-[11px] text-slate-500 font-mono">{String(log.meta.wardKey).replace('ward_', 'Ward ')} / {String(log.meta.roomKey || '').replace('room_', 'Room ')}</span>}
                        </div>
                        <p className="text-sm text-slate-300 break-words">{log.message}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-xs font-mono text-slate-300">{timeStr}</p>
                        <p className="text-[10px] text-slate-600 mt-0.5">{dateStr}</p>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}
      </main >

      <SpeedInsights />

      {/* --- MODALS --- */}

      {/* 1. Resolution Confirmation Modal โ€” Premium Redesign */}
      {resolvingRoom && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setResolvingRoom(null); }}
        >
          <div className="relative bg-slate-900 border border-amber-500/30 rounded-3xl w-full max-w-md shadow-[0_0_60px_rgba(245,158,11,0.15)] overflow-hidden">

            {/* Glowing top bar */}
            <div className="h-1 w-full bg-gradient-to-r from-amber-500 via-yellow-400 to-amber-500" />

            {/* Header */}
            <div className="px-8 pt-8 pb-6 text-center space-y-4">
              {/* Animated Icon */}
              <div className="relative mx-auto w-20 h-20">
                <div className="absolute inset-0 rounded-full bg-amber-500/20 animate-ping" />
                <div className="relative w-20 h-20 rounded-full bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center shadow-lg shadow-amber-500/30">
                  <Stethoscope size={36} className="text-white" />
                </div>
              </div>

              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-amber-400 mb-1">Assistance Protocol</p>
                <h2 className="text-2xl font-bold text-white">Patient Assistance Complete?</h2>
                <p className="text-slate-400 text-sm mt-2">
                  Confirm that emergency in{' '}
                  <span className="text-amber-400 font-bold">
                    {resolvingRoom.wardKey?.replace('ward_', 'Ward ')} โ€” {resolvingRoom.roomKey?.replace('room_', 'Room ')}
                  </span>{' '}
                  has been fully resolved.
                </p>
              </div>
            </div>

            {/* Checklist */}
            <div className="mx-6 mb-6 bg-slate-950/60 rounded-2xl border border-slate-800 p-4 space-y-3">
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-3">Pre-Reset Checklist</p>
              {[
                { icon: '๐ฉบ', text: 'Patient has been assessed by staff' },
                { icon: '๐””', text: 'Physical alarms have been silenced' },
                { icon: '๐“ก', text: 'All monitoring devices are operational' },
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-800/40 transition-colors">
                  <span className="text-lg">{item.icon}</span>
                  <span className="text-sm text-slate-300">{item.text}</span>
                </div>
              ))}
            </div>

            {/* Action Buttons */}
            <div className="px-6 pb-8 grid grid-cols-2 gap-3">
              <button
                onClick={() => setResolvingRoom(null)}
                className="py-3.5 px-4 bg-slate-800/80 hover:bg-slate-700 text-slate-300 font-bold rounded-2xl border border-slate-700 hover:border-slate-500 transition-all active:scale-95 flex items-center justify-center gap-2"
              >
                <X size={18} /> Cancel
              </button>
              <button
                onClick={confirmResolution}
                className="py-3.5 px-4 bg-gradient-to-r from-amber-500 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-slate-900 font-bold rounded-2xl transition-all active:scale-95 shadow-lg shadow-amber-900/30 flex items-center justify-center gap-2"
              >
                <CheckCircle size={18} /> Confirm & Clear
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2. Room Details Modal */}
      {viewingRoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-2xl w-full shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">

            {/* Header */}
            <div className="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-800/30">
              <div>
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  <LayoutDashboard className="text-blue-400" size={24} />
                  {viewingRoom.roomKey.replace('room_', 'Room ')} Details
                </h2>
                <p className="text-slate-400 text-sm mt-1">
                  Patient: <span className="text-slate-200 font-bold">{viewingRoom.patient_info?.name || viewingRoom.config?.patient_name || 'Unassigned'}</span>
                </p>
              </div>
              <button
                onClick={() => setViewingRoom(null)}
                className="p-2 hover:bg-slate-800 rounded-full text-slate-400 hover:text-white transition-colors"
              >
                <X size={24} />
              </button>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">

              {/* Status Section */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                  <p className="text-xs text-slate-500 mb-1 font-bold uppercase">Current Status</p>
                  <div className="flex items-center gap-2">
                    {viewingRoom.live_status?.fall_detected ? (
                      <>
                        <ShieldAlert className="text-red-500" />
                        <span className="text-red-500 font-bold">Fall Detected</span>
                      </>
                    ) : (
                      <>
                        <Activity className="text-emerald-500" />
                        <span className="text-emerald-500 font-bold">Normal Monitoring</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                  <p className="text-xs text-slate-500 mb-1 font-bold uppercase">Last Update</p>
                  <p className="text-slate-300 font-mono text-sm">
                    {viewingRoom.fall_detection?.last_update || "No Data"}
                  </p>
                </div>
              </div>

              {/* Devices List */}
              <div>
                <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-3">Connected Devices</h3>
                <div className="space-y-3">
                  {Object.entries(viewingRoom.devices || {}).filter(([n]) => n !== 'Pir_Motion_Sensor').map(([devName, devData]) => (
                    <div key={devName} className="bg-slate-800/40 p-4 rounded-xl border border-slate-700/50 flex flex-col sm:flex-row justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-slate-900 rounded-lg text-blue-400">
                          {devName.includes('CAM') ? <Camera size={20} /> : <Cpu size={20} />}
                        </div>
                        <div>
                          <p className="font-bold text-slate-200">{devName}</p>
                          <p className="text-xs text-slate-500 font-mono mt-0.5">IP: {devData.ip || 'N/A'}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <span className={cn(
                          "text-xs font-bold px-2 py-1 rounded-full inline-block mb-1",
                          (devData.Status === 'Normal' || devData.status === 'Online') ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-500"
                        )}>
                          {devData.Status || devData.status || 'Offline'}
                        </span>
                        {devData.stream_url && (
                          <div className="mt-1">
                            <a href={devData.stream_url} target="_blank" rel="noopener" className="text-xs text-blue-400 hover:underline flex items-center justify-end gap-1">
                              View Stream <ExternalLink size={10} />
                            </a>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {Object.keys(viewingRoom.devices || {}).filter(n => n !== 'Pir_Motion_Sensor').length === 0 && (
                    <p className="text-slate-500 italic text-sm text-center py-4">No devices connected.</p>
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-slate-800 bg-slate-900 flex justify-end">
              <button
                onClick={() => setViewingRoom(null)}
                className="px-6 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg font-bold transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div >
  );
}
