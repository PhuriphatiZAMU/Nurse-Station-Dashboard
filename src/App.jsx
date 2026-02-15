import React, { useState, useEffect, useRef, useCallback } from 'react';
import { initializeApp } from "firebase/app";
import { getDatabase, ref, onValue, update } from "firebase/database";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";
import { getAnalytics } from "firebase/analytics";
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
  Link2
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
const analytics = getAnalytics(app); // Initialize Analytics
const db = getDatabase(app);
const auth = getAuth(app);

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
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
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
  const [activeTab, setActiveTab] = useState('monitor'); // 'monitor' | 'devices'
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);

  // Data State
  const [wardData, setWardData] = useState({});
  const [devices, setDevices] = useState({});
  const [sensorData, setSensorData] = useState({}); // /sensor_data (global fall status from ESP)
  const [editingDevice, setEditingDevice] = useState(null);

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
      updates[`hospital_system/devices/${deviceId}/config/assigned_room`] = normalizedRoom; // Legacy field consistent

      // OPTIONAL: Update Ward Data directly so changes reflect immediately even if device is offline
      // This makes the dashboard feel "instant"
      updates[`hospital_system/wards/ward_A/${normalizedRoom}/patient_info/name`] = patientName;

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
    let unsubscribeSensor = null;

    const setupListeners = () => {
      // 1. Listen to Ward Data
      const wardsRef = ref(db, 'hospital_system/wards/ward_A');
      unsubscribeWards = onValue(wardsRef, (snapshot) => {
        const data = snapshot.val() || {};
        setWardData(data);
        setConnected(true);
        setError(null); // Clear setup/connection errors on success
        setLoading(false);
      }, (err) => {
        console.error("Ward Listen Error:", err);
        setError("Connection lost: " + err.message);
        setConnected(false);
      });

      // 2. Listen to Devices
      const devicesRef = ref(db, 'hospital_system/devices');
      unsubscribeDevices = onValue(devicesRef, (snapshot) => {
        setDevices(snapshot.val() || {});
      }, (err) => console.error("Device Listen Error:", err));

      // 3. Listen to sensor_data (global ESP fall status)
      const sensorRef = ref(db, 'sensor_data');
      unsubscribeSensor = onValue(sensorRef, (snapshot) => {
        setSensorData(snapshot.val() || {});
      }, (err) => console.error("Sensor Listen Error:", err));
    };

    // Authenticate (Anonymous)
    // Authenticate (Anonymous)
    const isPlaceholderKey = !firebaseConfig.apiKey || firebaseConfig.apiKey === 'your-api-key-here';

    if (isPlaceholderKey) {
      console.warn("⚠️ No valid API Key found. Skipping Auth and attempting direct DB connection.");
      // Try to listen without auth (works if rules are .read: true)
      setupListeners();

      if (!connected) {
        setError("Setup Required: Valid Web API Key missing.");
      }
      setLoading(false);
    } else {
      signInAnonymously(auth)
        .then(() => {
          console.log("🔥 Firebase Auth: Signed in anonymously");
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
      if (unsubscribeSensor) unsubscribeSensor();
    };
  }, []); // Run once on mount

  // Alert Logic based on Data
  // Checks THREE possible fall indicators:
  //   1. room.live_status?.fall_detected (ideal structure)
  //   2. room.motion?.val > 0 (ESP32-S3-CAM sends motion.val = 1 on fall)
  //   3. sensorData.status === 'Fall Down' (global /sensor_data from ESP)
  useEffect(() => {
    let emergency = false;
    let alertRoom = null;

    // Check ward rooms for fall detection
    Object.entries(wardData).forEach(([roomKey, room]) => {
      // Method 1: live_status.fall_detected (ideal)
      if (room.live_status?.fall_detected) {
        emergency = true;
        alertRoom = roomKey;
      }
      // Method 2: motion.val > 0 (actual ESP data structure)
      if (room.motion?.val > 0) {
        emergency = true;
        alertRoom = roomKey;
      }
    });

    // Method 3: Global sensor_data.status (fallback from ESP)
    if (sensorData?.status === 'Fall Down' || sensorData?.status === 'fall_detected') {
      emergency = true;
    }

    // Only update state if changed to prevent loops
    if (emergency !== activeAlert) {
      setActiveAlert(emergency);
      if (emergency) {
        setAlarmAcknowledged(false); // Reset ack on new alert
        console.log('🚨 FALL ALERT triggered!', { alertRoom, sensorStatus: sensorData?.status });

        // --- IMMEDIATE SYSTEM ALERT (Background/Locked fallback) ---
        // 1. Vibrate device (SOS Pattern: ... --- ...)
        if (navigator.vibrate) {
          navigator.vibrate([100, 50, 100, 50, 100, 200, 300, 100, 300, 100, 300, 200, 100, 50, 100, 50, 100]);
        }

        // 2. System Notification (Visual + Sound outside browser)
        if ("Notification" in window && Notification.permission === "granted") {
          try {
            new Notification("🚨 FALL DETECTED!", {
              body: alertRoom
                ? `Room ${alertRoom.replace('room_', '')} — Patient requires assistance!`
                : "Connect to Dashboard immediately! Patient requires assistance.",
              icon: "/vite.png",
              requireInteraction: true,
              tag: "fall-alert"
            });
          } catch (e) { console.error("Notification failed", e); }
        }
      }
    }
  }, [wardData, sensorData, activeAlert]);

  // Alarm Control Effect
  useEffect(() => {
    if (activeAlert && !isMuted && !alarmAcknowledged) {
      alarmRef.current?.play();
    } else {
      alarmRef.current?.stop();
    }
  }, [activeAlert, isMuted, alarmAcknowledged]);

  // Actions
  const handleAssignRoom = async (deviceId, roomKey) => {
    try {
      const deviceRef = ref(db, `hospital_system/devices/${deviceId}/config`);
      await update(deviceRef, { assigned_room: roomKey });
      console.log(`Assigned ${deviceId} to ${roomKey}`);
    } catch (err) {
      console.error("Assign Error:", err);
      alert("Failed to assign room: " + err.message);
    }
  };

  const handleUnlink = async (deviceId) => {
    if (!window.confirm("Unlink this device from its room?")) return;
    try {
      const deviceRef = ref(db, `hospital_system/devices/${deviceId}/config`);
      await update(deviceRef, { assigned_room: 'none' });
    } catch (err) {
      console.error("Unlink Error:", err);
    }
  };

  const getRoomOptions = () => {
    return Object.keys(wardData).map(key => ({
      value: key,
      label: `Room ${key.replace('room_', '')}`
    }));
  };

  // Global Auto-Unlock (Any interaction enabling audio)
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
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsMuted(!isMuted)}
            className={cn(
              "relative p-2.5 rounded-lg transition-colors border border-transparent",
              isMuted ? "bg-red-500/10 text-red-500 border-red-500/20" : "text-slate-400 hover:bg-slate-800 hover:text-white",
              !audioReady && "opacity-50"
            )}
            title={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
            {!audioReady && <span className="absolute -top-1 -right-1 flex h-3 w-3"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75"></span><span className="relative inline-flex rounded-full h-3 w-3 bg-yellow-500"></span></span>}
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
              Get API Key →
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
              <div className="p-6 bg-gradient-to-r from-red-600 to-red-800 rounded-2xl shadow-2xl animate-bounce flex flex-wrap items-center justify-between gap-4 text-white">
                <div className="flex items-center gap-4">
                  <ShieldAlert size={40} className="animate-pulse" />
                  <div>
                    <h2 className="text-2xl font-bold">EMERGENCY ALERT</h2>
                    <p className="text-red-100">Fall detected! Check indicated rooms immediately.</p>
                  </div>
                </div>
                {!alarmAcknowledged ? (
                  <button
                    onClick={() => { setAlarmAcknowledged(true); alarmRef.current?.stop(); }}
                    className="px-6 py-3 bg-white text-red-600 font-bold rounded-xl shadow-lg hover:bg-gray-100 transition transform hover:scale-105"
                  >
                    ACKNOWLEDGE
                  </button>
                ) : (
                  <div className="flex items-center gap-2 bg-black/20 px-4 py-2 rounded-lg">
                    <span>✓ Acknowledged</span>
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {Object.entries(wardData).map(([key, room]) => {
                // Fall detection: check live_status OR motion.val OR global sensor_data
                const isEmergency = room.live_status?.fall_detected || (room.motion?.val > 0) || (sensorData?.status === 'Fall Down');
                const isOffline = room.live_status?.online === false; // Only offline if explicitly set to false

                return (
                  <div key={key} className={cn(
                    "relative overflow-hidden rounded-3xl border transition-all duration-300 group",
                    isEmergency
                      ? "bg-red-900/40 border-red-500 shadow-[0_0_30px_rgba(220,38,38,0.3)] scale-[1.02]"
                      : "bg-slate-900/40 border-slate-800 hover:border-slate-700 hover:-translate-y-1 hover:shadow-xl backdrop-blur-sm"
                  )}>
                    {/* Card Header */}
                    <div className="p-6 border-b border-white/5 flex justify-between items-start">
                      <div className="flex items-center gap-4">
                        <div className={cn(
                          "w-14 h-14 rounded-2xl flex items-center justify-center text-white font-bold text-xl shadow-lg transition-transform group-hover:scale-110",
                          isEmergency ? "bg-red-600" : "bg-slate-800"
                        )}>
                          {key.replace('room_', '')}
                        </div>
                        <div>
                          <h3 className="text-lg font-bold text-slate-100">
                            {room.patient_info?.name || room.config?.patient_name || `Room ${key.replace('room_', '')}`}
                          </h3>
                          <p className={cn(
                            "text-xs font-bold uppercase tracking-wider flex items-center gap-1.5",
                            isOffline ? "text-slate-500" : "text-green-500"
                          )}>
                            <span className={cn("w-1.5 h-1.5 rounded-full", isOffline ? "bg-slate-600" : "bg-green-500")} />
                            {isOffline ? "OFFLINE" : "ACTIVE MONITORING"}
                          </p>
                        </div>
                      </div>
                      {isEmergency && <ShieldAlert className="text-red-500 animate-pulse" size={28} />}
                    </div>

                    {/* Card Body */}
                    <div className="p-6 space-y-4">
                      <div className="flex items-center justify-between p-3 bg-slate-950/30 rounded-xl">
                        <div className="flex items-center gap-3 text-slate-400">
                          <Activity size={18} />
                          <span className="text-sm">Status</span>
                        </div>
                        <span className={cn(
                          "font-bold text-sm px-3 py-1 rounded-full",
                          isEmergency ? "bg-red-500/20 text-red-500 animate-pulse" : "bg-green-500/20 text-green-500"
                        )}>
                          {isEmergency ? "🚨 FALL DETECTED" : "Normal"}
                        </span>
                      </div>
                    </div>

                    {/* Card Footer */}
                    <div className="p-4 bg-slate-950/50 flex gap-3">
                      <button className={cn(
                        "flex-1 py-3 rounded-xl font-bold text-sm transition-all shadow-lg",
                        isEmergency
                          ? "bg-red-600 text-white hover:bg-red-500"
                          : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                      )}>
                        {isEmergency ? "RESPOND NOW" : "View Details"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* --- Devices Tab: Pairing & Management --- */}
        {activeTab === 'devices' && (() => {
          // === Group devices by assigned room ===
          const roomPairings = {}; // { room_301: { cam: [...], monitor: [...] } }
          const pendingDevices = []; // devices not yet assigned

          Object.entries(devices).forEach(([deviceId, device]) => {
            const room = device.config?.assigned_room;
            const isPaired = room && room !== 'none';
            const isCAM = device.info?.model?.toUpperCase().includes('CAM') || device.info?.type?.toUpperCase().includes('CAM');

            if (isPaired) {
              if (!roomPairings[room]) roomPairings[room] = { cam: [], monitor: [] };
              if (isCAM) {
                roomPairings[room].cam.push({ id: deviceId, ...device });
              } else {
                roomPairings[room].monitor.push({ id: deviceId, ...device });
              }
            } else {
              pendingDevices.push({ id: deviceId, ...device });
            }
          });

          const pairedRooms = Object.entries(roomPairings);

          return (
            <div className="space-y-6 animate-in fade-in zoom-in duration-300">
              {/* Header */}
              <div className="bg-slate-900/50 backdrop-blur-md rounded-2xl border border-slate-800 p-6 shadow-xl">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
                  <div>
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                      <Cpu className="text-blue-400" />
                      🔌 Device Pairing & Management
                    </h2>
                    <p className="text-slate-400 text-sm mt-1">
                      Plug & Play — ESP32_S3_CAM + Nurse_Monitor auto-pair per room
                    </p>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <span className="bg-emerald-500/10 text-emerald-400 px-3 py-1.5 rounded-full text-xs font-bold border border-emerald-500/20 flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                      {pairedRooms.filter(([, g]) => g.cam.length > 0 && g.monitor.length > 0).length} Complete
                    </span>
                    <span className="bg-cyan-500/10 text-cyan-400 px-3 py-1.5 rounded-full text-xs font-bold border border-cyan-500/20 flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-cyan-500" />
                      {pairedRooms.filter(([, g]) => g.cam.length === 0 || g.monitor.length === 0).length} Partial
                    </span>
                    <span className="bg-amber-500/10 text-amber-400 px-3 py-1.5 rounded-full text-xs font-bold border border-amber-500/20 flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-amber-500" />
                      {pendingDevices.length} Pending
                    </span>
                    <span className="bg-blue-500/10 text-blue-400 px-3 py-1.5 rounded-full text-xs font-bold border border-blue-500/20">
                      {Object.keys(devices).length} Total
                    </span>
                  </div>
                </div>

                {/* ====== PAIRED ROOM CARDS ====== */}
                {pairedRooms.length > 0 && (
                  <div className="mb-2">
                    <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                      <Link2 size={14} /> Paired Rooms ({pairedRooms.length})
                    </h3>
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                      {pairedRooms.map(([roomKey, group]) => {
                        const roomData = wardData[roomKey];
                        const isFallDetected = roomData?.live_status?.fall_detected || (roomData?.motion?.val > 0) || (sensorData?.status === 'Fall Down') || false;
                        const patientName = roomData?.patient_info?.name || 'Unknown Patient';
                        const isComplete = group.cam.length > 0 && group.monitor.length > 0;
                        const allDevices = [...group.cam, ...group.monitor];

                        return (
                          <div
                            key={roomKey}
                            className={cn(
                              "rounded-2xl border-2 overflow-hidden transition-all duration-500",
                              isFallDetected
                                ? "border-red-500/60 bg-red-950/20 shadow-[0_0_25px_rgba(220,38,38,0.2)]"
                                : isComplete
                                  ? "border-emerald-500/30 bg-slate-800/40 hover:border-emerald-400/50"
                                  : "border-cyan-500/30 bg-slate-800/40 hover:border-cyan-400/50"
                            )}
                          >
                            {/* Room Header */}
                            <div className={cn(
                              "px-5 py-3 flex items-center justify-between border-b",
                              isFallDetected ? "bg-red-900/30 border-red-800/50" : "bg-slate-900/60 border-slate-700/50"
                            )}>
                              <div className="flex items-center gap-3">
                                <div className={cn(
                                  "w-10 h-10 rounded-xl flex items-center justify-center text-base font-bold",
                                  isFallDetected ? "bg-red-600 text-white animate-pulse" : "bg-slate-700 text-white"
                                )}>
                                  {roomKey.replace('room_', '')}
                                </div>
                                <div>
                                  <h4 className="text-sm font-bold text-white">{patientName}</h4>
                                  <p className={cn(
                                    "text-[11px] flex items-center gap-1",
                                    isFallDetected ? "text-red-400 font-bold" : "text-emerald-400"
                                  )}>
                                    <span className={cn("w-1.5 h-1.5 rounded-full", isFallDetected ? "bg-red-500 animate-pulse" : "bg-emerald-500")} />
                                    {isFallDetected ? '⚠ FALL DETECTED' : 'Monitoring Active'}
                                  </p>
                                </div>
                              </div>
                              <span className={cn(
                                "px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider",
                                isComplete
                                  ? "bg-emerald-900/60 text-emerald-300 border border-emerald-500/30"
                                  : "bg-cyan-900/60 text-cyan-300 border border-cyan-500/30"
                              )}>
                                {isComplete ? '✓ COMPLETE' : '◐ PARTIAL'}
                              </span>
                            </div>

                            {/* Devices Row */}
                            <div className="p-4">
                              <div className="flex flex-col sm:flex-row items-stretch gap-3">
                                {/* Camera Device(s) */}
                                <div className={cn(
                                  "flex-1 p-3.5 rounded-xl border transition-all",
                                  group.cam.length > 0
                                    ? "bg-slate-900/50 border-blue-500/20"
                                    : "bg-slate-900/20 border-dashed border-slate-700 opacity-50"
                                )}>
                                  <div className="flex items-center gap-2 mb-2">
                                    <Camera size={14} className="text-blue-400" />
                                    <span className="text-[11px] font-bold text-blue-400 uppercase tracking-wider">Camera</span>
                                    {group.cam.length > 0 && (
                                      <span className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.6)]" />
                                    )}
                                  </div>
                                  {group.cam.length > 0 ? group.cam.map(d => {
                                    const camOnline = (Date.now() - (d.status?.last_seen || 0)) < 60000;
                                    return (
                                      <div key={d.id} className="space-y-1">
                                        <p className="text-xs font-mono font-bold text-white truncate">{d.id}</p>
                                        <p className="text-[11px] text-slate-500">{d.info?.model || 'ESP32-S3-CAM'}</p>
                                        <div className="flex justify-between text-[11px] text-slate-400">
                                          <span>IP: <span className="font-mono text-slate-300">{d.info?.ip || 'N/A'}</span></span>
                                          <span className={camOnline ? 'text-emerald-400' : 'text-slate-500'}>{camOnline ? '● On' : '○ Off'}</span>
                                        </div>
                                        {d.info?.ip && (
                                          <a href={`http://${d.info.ip}/capture`} target="_blank" rel="noopener noreferrer"
                                            className="text-[10px] text-blue-400 hover:text-blue-300 flex items-center gap-1 mt-1">
                                            <Camera size={9} /> Stream <ExternalLink size={8} />
                                          </a>
                                        )}
                                      </div>
                                    );
                                  }) : (
                                    <p className="text-[11px] text-slate-600 italic">No camera assigned</p>
                                  )}
                                </div>

                                {/* Pairing Connector */}
                                <div className="flex sm:flex-col items-center justify-center gap-1 py-1 sm:py-0 sm:px-1">
                                  <div className="hidden sm:block w-px h-4 bg-gradient-to-b from-transparent via-slate-600 to-transparent" />
                                  <div className={cn(
                                    "w-8 h-8 rounded-full flex items-center justify-center border-2 transition-all",
                                    isComplete
                                      ? isFallDetected
                                        ? "bg-red-600 border-red-500 text-white animate-pulse shadow-[0_0_12px_rgba(220,38,38,0.5)]"
                                        : "bg-emerald-600/80 border-emerald-500/50 text-white shadow-[0_0_8px_rgba(16,185,129,0.3)]"
                                      : "bg-slate-700 border-slate-600 text-slate-400"
                                  )}>
                                    {isFallDetected ? <ShieldAlert size={14} /> : isComplete ? <Link2 size={14} /> : '?'}
                                  </div>
                                  <div className="hidden sm:block w-px h-4 bg-gradient-to-b from-transparent via-slate-600 to-transparent" />
                                </div>

                                {/* Monitor Device(s) */}
                                <div className={cn(
                                  "flex-1 p-3.5 rounded-xl border transition-all",
                                  group.monitor.length > 0
                                    ? "bg-slate-900/50 border-violet-500/20"
                                    : "bg-slate-900/20 border-dashed border-slate-700 opacity-50"
                                )}>
                                  <div className="flex items-center gap-2 mb-2">
                                    <Monitor size={14} className="text-violet-400" />
                                    <span className="text-[11px] font-bold text-violet-400 uppercase tracking-wider">Nurse Monitor</span>
                                    {group.monitor.length > 0 && (
                                      <span className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.6)]" />
                                    )}
                                  </div>
                                  {group.monitor.length > 0 ? group.monitor.map(d => {
                                    const monOnline = (Date.now() - (d.status?.last_seen || 0)) < 60000;
                                    return (
                                      <div key={d.id} className="space-y-1">
                                        <p className="text-xs font-mono font-bold text-white truncate">{d.id}</p>
                                        <p className="text-[11px] text-slate-500">{d.info?.model || 'Nurse_Monitor_V2'}</p>
                                        <div className="flex justify-between text-[11px] text-slate-400">
                                          <span>IP: <span className="font-mono text-slate-300">{d.info?.ip || 'N/A'}</span></span>
                                          <span className={monOnline ? 'text-emerald-400' : 'text-slate-500'}>{monOnline ? '● On' : '○ Off'}</span>
                                        </div>
                                      </div>
                                    );
                                  }) : (
                                    <p className="text-[11px] text-slate-600 italic">No monitor assigned</p>
                                  )}
                                </div>
                              </div>

                              {/* Room Actions */}
                              <div className="flex gap-2 mt-3 pt-3 border-t border-slate-700/50">
                                {allDevices.map(d => (
                                  <button
                                    key={`edit-${d.id}`}
                                    onClick={() => setEditingDevice(d.id)}
                                    className="flex-1 py-1.5 bg-blue-600/15 text-blue-400 hover:bg-blue-600/25 rounded-lg transition text-[11px] font-medium flex items-center justify-center gap-1 truncate"
                                    title={`Edit ${d.id}`}
                                  >
                                    <Settings size={10} /> {d.id.substring(0, 12)}
                                  </button>
                                ))}
                                <button
                                  onClick={() => {
                                    if (window.confirm(`Unlink all devices from ${roomKey.replace('room_', 'Room ')}?`)) {
                                      allDevices.forEach(d => handleUnlink(d.id));
                                    }
                                  }}
                                  className="py-1.5 px-3 bg-red-600/10 text-red-400 hover:bg-red-600/20 rounded-lg transition text-[11px]"
                                  title="Unlink all from room"
                                >
                                  <Unplug size={13} />
                                </button>
                              </div>

                              {/* Inline Edit (if editing any device in this room) */}
                              {allDevices.some(d => editingDevice === d.id) && (() => {
                                const d = allDevices.find(d => editingDevice === d.id);
                                return (
                                  <div className="mt-3 p-4 bg-slate-950/60 rounded-xl border border-blue-500/20 space-y-3">
                                    <div className="flex items-center gap-2">
                                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-900/60 text-blue-300 border border-blue-500/30">EDITING</span>
                                      <span className="text-xs font-mono text-blue-400">{d.id}</span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                      <div>
                                        <label className="block text-[11px] text-slate-500 mb-1">Room ID</label>
                                        <input type="text" defaultValue={roomKey.replace('room_', '')} id={`edit-room-${d.id}`}
                                          className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 outline-none" placeholder="301" />
                                      </div>
                                      <div>
                                        <label className="block text-[11px] text-slate-500 mb-1">Patient Name</label>
                                        <input type="text" defaultValue={d.config?.patient_name || roomData?.patient_info?.name || ''} id={`edit-patient-${d.id}`}
                                          className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 outline-none" placeholder="Patient" />
                                      </div>
                                    </div>
                                    <div className="flex gap-2">
                                      <button onClick={() => {
                                        handleSaveConfig(d.id, document.getElementById(`edit-room-${d.id}`).value, document.getElementById(`edit-patient-${d.id}`).value);
                                      }} className="flex-1 py-2 bg-emerald-600 text-white font-bold text-sm rounded-lg hover:bg-emerald-500 transition flex items-center justify-center gap-1">
                                        <Save size={14} /> Save
                                      </button>
                                      <button onClick={() => setEditingDevice(null)} className="px-4 py-2 bg-slate-700 text-slate-300 text-sm rounded-lg hover:bg-slate-600 transition">Cancel</button>
                                    </div>
                                  </div>
                                );
                              })()}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* ====== PENDING (UNPAIRED) DEVICES ====== */}
                {pendingDevices.length > 0 && (
                  <div className={pairedRooms.length > 0 ? "mt-6" : ""}>
                    <h3 className="text-sm font-bold text-amber-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                      <AlertTriangle size={14} /> Pending Devices ({pendingDevices.length})
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {pendingDevices.map((device) => {
                        const deviceId = device.id;
                        const isEditing = editingDevice === deviceId;
                        const isOnline = (Date.now() - (device.status?.last_seen || 0)) < 60000;
                        const isCAM = device.info?.model?.toUpperCase().includes('CAM') || device.info?.type?.toUpperCase().includes('CAM');

                        return (
                          <div
                            key={deviceId}
                            className="p-4 rounded-xl border-2 border-amber-500/30 bg-slate-800/40 hover:border-amber-400/50 transition-all duration-300"
                          >
                            <div className="flex justify-between items-start mb-3">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" />
                                  <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-900/60 text-amber-300 border border-amber-500/30">
                                    PENDING
                                  </span>
                                </div>
                                <h3 className="text-sm font-mono font-bold text-blue-400 truncate">{deviceId}</h3>
                                <p className="text-xs text-slate-500 mt-0.5">
                                  {device.info?.model || 'Unknown'}
                                  {device.info?.type ? ` • ${device.info.type}` : ''}
                                </p>
                              </div>
                              <div className="flex items-center gap-2 ml-2">
                                {isCAM ? <Camera size={14} className="text-blue-400" /> : <Monitor size={14} className="text-violet-400" />}
                                <span className={cn("w-2 h-2 rounded-full", isOnline ? "bg-emerald-500" : "bg-slate-600")} />
                              </div>
                            </div>

                            <div className="space-y-1.5 mb-3 text-xs text-slate-400">
                              <div className="flex justify-between">
                                <span>Type</span>
                                <span className={isCAM ? "text-blue-400 font-medium" : "text-violet-400 font-medium"}>
                                  {isCAM ? '📷 Camera' : '🖥️ Monitor'}
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span>IP</span>
                                <span className="font-mono text-slate-300">{device.info?.ip || 'N/A'}</span>
                              </div>
                              <div className="flex justify-between">
                                <span>Network</span>
                                <span className={isOnline ? "text-emerald-400" : "text-slate-500"}>
                                  {isOnline ? '● Online' : '○ Offline'}
                                </span>
                              </div>
                            </div>

                            {isEditing ? (
                              <div className="space-y-3 p-3 bg-slate-950/50 rounded-lg border border-slate-700">
                                <div>
                                  <label className="block text-[11px] text-slate-500 mb-1">Room ID</label>
                                  <input type="text" defaultValue="" id={`edit-room-${deviceId}`}
                                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 outline-none" placeholder="e.g. 301" />
                                </div>
                                <div>
                                  <label className="block text-[11px] text-slate-500 mb-1">Patient Name</label>
                                  <input type="text" defaultValue="" id={`edit-patient-${deviceId}`}
                                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 outline-none" placeholder="Patient Name" />
                                </div>
                                <div className="flex gap-2">
                                  <button onClick={() => {
                                    handleSaveConfig(deviceId, document.getElementById(`edit-room-${deviceId}`).value, document.getElementById(`edit-patient-${deviceId}`).value);
                                  }} className="flex-1 py-2 bg-emerald-600 text-white font-bold text-sm rounded-lg hover:bg-emerald-500 transition flex items-center justify-center gap-1">
                                    <Save size={14} /> Pair & Save
                                  </button>
                                  <button onClick={() => setEditingDevice(null)} className="px-4 py-2 bg-slate-700 text-slate-300 text-sm rounded-lg hover:bg-slate-600 transition">
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="space-y-2">
                                <div>
                                  <label className="block text-[11px] text-slate-500 mb-1">Assign to Room:</label>
                                  <div className="relative">
                                    <select
                                      value="none"
                                      onChange={(e) => handleAssignRoom(deviceId, e.target.value)}
                                      className="appearance-none w-full bg-slate-950 border border-slate-700 text-white py-2 px-3 pr-8 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
                                    >
                                      <option value="none">-- Select Room --</option>
                                      {getRoomOptions().map(opt => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                      ))}
                                    </select>
                                    <Settings size={14} className="absolute right-3 top-2.5 text-slate-500 pointer-events-none" />
                                  </div>
                                </div>
                                <button
                                  onClick={() => setEditingDevice(deviceId)}
                                  className="w-full py-2 bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 rounded-lg transition text-xs font-medium flex items-center justify-center gap-1"
                                >
                                  <Settings size={12} /> Manual Pair
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Empty State */}
                {Object.keys(devices).length === 0 && (
                  <div className="text-center py-16 text-slate-500">
                    <Cpu size={48} className="mx-auto mb-4 opacity-30" />
                    <p className="text-lg font-medium">No devices found</p>
                    <p className="text-sm mt-1">Power on your ESP8266 or ESP32-S3-CAM to see them here.</p>
                  </div>
                )}
              </div>
            </div>
          );
        })()}


      </main>

      <SpeedInsights />
    </div>
  );
}
