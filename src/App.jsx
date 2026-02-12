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
  AlertTriangle
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

    const unlockHandler = () => {
      this._unlock();
      ['click', 'touchstart', 'touchend', 'keydown'].forEach(evt => {
        document.removeEventListener(evt, unlockHandler, { capture: true });
      });
    };

    ['click', 'touchstart', 'touchend', 'keydown'].forEach(evt => {
      document.addEventListener(evt, unlockHandler, { capture: true, passive: true });
    });
  }

  async _unlock() {
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
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
    const duration = 1.8;
    const length = sampleRate * duration;
    const buffer = this.audioCtx.createBuffer(1, length, sampleRate);
    const channel = buffer.getChannelData(0);

    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const cyclePos = t % 0.4;
      const freq = cyclePos < 0.2 ? 880 : 660;
      const wave = Math.sin(2 * Math.PI * freq * t) > 0 ? 0.7 : -0.7;

      let envelope = 1;
      const beepPos = t % 0.2;
      if (beepPos < 0.005) envelope = beepPos / 0.005;
      if (beepPos > 0.18) envelope = (0.2 - beepPos) / 0.02;
      if (t > 1.6) envelope *= (duration - t) / 0.2;

      channel[i] = wave * envelope;
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

  // Alert Logic based on Data
  useEffect(() => {
    let emergency = false;
    Object.values(wardData).forEach(room => {
      if (room.live_status?.fall_detected) emergency = true;
    });

    // Only update state if changed to prevent loops
    if (emergency !== activeAlert) {
      setActiveAlert(emergency);
      if (emergency) {
        setAlarmAcknowledged(false); // Reset ack on new alert

        // --- IMMEDIATE SYSTEM ALERT (Background/Locked fallback) ---
        // 1. Vibrate device (SOS Pattern: ... --- ...)
        if (navigator.vibrate) {
          navigator.vibrate([100, 50, 100, 50, 100, 200, 300, 100, 300, 100, 300, 200, 100, 50, 100, 50, 100]);
        }

        // 2. System Notification (Visual + Sound outside browser)
        if ("Notification" in window && Notification.permission === "granted") {
          try {
            new Notification("🚨 FALL DETECTED!", {
              body: "Connect to Dashboard immediately! Patient requires assistance.",
              icon: "/vite.png", // Use our new logo
              requireInteraction: true, // Keep notification until clicked
              tag: "fall-alert" // Prevent duplicate stacking
            });
          } catch (e) { console.error("Notification failed", e); }
        }
      }
    }
  }, [wardData, activeAlert]);

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

    window.addEventListener('click', unlockAudio, { once: true });
    window.addEventListener('touchstart', unlockAudio, { once: true });

    // Attempt immediate unlock (might work if cached permission)
    unlockAudio();

    return () => {
      window.removeEventListener('click', unlockAudio);
      window.removeEventListener('touchstart', unlockAudio);
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
                const isEmergency = room.live_status?.fall_detected;
                const isOffline = !room.live_status?.online; // Assume 'online' field exists or check timestamp (not implemented here for brevity)

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
                            {room.patient_info?.name || "Unknown Patient"}
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
                          isEmergency ? "bg-red-500/20 text-red-500" : "bg-green-500/20 text-green-500"
                        )}>
                          {isEmergency ? "FALL DETECTED" : "Normal"}
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

        {/* TAB: DEVICE MANAGER */}
        {activeTab === 'devices' && (
          <div className="bg-slate-900/40 border border-slate-800 rounded-3xl overflow-hidden backdrop-blur-sm">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-900/60">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Cpu className="text-blue-500" /> Connected Devices
              </h2>
              <span className="bg-blue-500/10 text-blue-400 px-3 py-1 rounded-full text-xs font-bold border border-blue-500/20">
                {Object.keys(devices).length} Devices Found
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-400">
                <thead className="bg-slate-950/50 text-slate-200 uppercase font-bold text-xs">
                  <tr>
                    <th className="px-6 py-4">Status</th>
                    <th className="px-6 py-4">Device Info</th>
                    <th className="px-6 py-4">Assigned Room</th>
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {Object.entries(devices).map(([deviceId, deviceData]) => {
                    const assignedRoom = deviceData.config?.assigned_room;
                    const isAssigned = assignedRoom && assignedRoom !== 'none';
                    // Check heartbeat timestamp if implemented, otherwise assume online for demo
                    const isOnline = true;

                    return (
                      <tr key={deviceId} className="hover:bg-slate-800/30 transition-colors">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            {isOnline ? <Wifi size={18} className="text-green-500" /> : <WifiOff size={18} className="text-slate-500" />}
                            <span className={isOnline ? "text-green-500 font-medium" : "text-slate-500"}>
                              {isOnline ? "Online" : "Offline"}
                            </span>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="font-medium text-white">{deviceId}</div>
                          <div className="text-xs text-slate-500 mt-1">
                            Model: {deviceData.info?.model || "ESP32-S3"} • IP: {deviceData.info?.ip || "192.168.1.x"}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="relative">
                            <select
                              value={assignedRoom || 'none'}
                              onChange={(e) => handleAssignRoom(deviceId, e.target.value)}
                              className={cn(
                                "appearance-none w-full bg-slate-950 border text-white py-2 px-3 pr-8 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer",
                                isAssigned ? "border-blue-500/30 text-blue-100" : "border-slate-700 text-slate-400"
                              )}
                            >
                              <option value="none">-- Unassigned --</option>
                              {getRoomOptions().map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                            <Settings size={14} className="absolute right-3 top-3 text-slate-500 pointer-events-none" />
                          </div>
                        </td>
                        <td className="px-6 py-4 text-right">
                          {isAssigned && (
                            <button
                              onClick={() => handleUnlink(deviceId)}
                              className="text-red-400 hover:text-red-300 hover:bg-red-500/10 p-2 rounded-lg transition-colors"
                              title="Unlink Device"
                            >
                              <Unplug size={18} />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {Object.keys(devices).length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-6 py-12 text-center text-slate-500">
                        No devices connected. Plug in a Monitor Node to start.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </main>

      <SpeedInsights />
    </div>
  );
}
