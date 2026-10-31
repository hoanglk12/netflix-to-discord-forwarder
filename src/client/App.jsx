import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Play,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Radio,
  Trash2,
  Plus,
  Eye,
  EyeOff,
  Send,
  ExternalLink,
  Copy,
  Check,
  Database,
  ShieldAlert,
  Sparkles,
  Terminal,
  Sun,
  Moon,
  Pause,
  ChevronDown,
  ChevronUp,
  KeyRound,
  Mail,
} from 'lucide-react';

const MAX_CHANNELS = 5;
const POLL_INTERVAL_MS = 10000;
const RUN_STORAGE_KEY = 'forwarder:lastRun:v2';

function maskSecrets(text) {
  return String(text ?? '')
    .replace(/(\/webhooks\/\d+\/)[A-Za-z0-9._~-]+/gi, '$1••••')
    .replace(/([?&](?:token|access_token|key)=)[^&\s"']+/gi, '$1••••');
}

function describeWebhookChannel(truncated) {
  const head = String(truncated ?? '').replace(/\.\.\.$/, '');
  const m = head.match(/^https?:\/\/([^/?#]+)(\/(?:[^?#]*\/)?webhooks\/)(\d*)/i);
  if (m) {
    return { head, host: m[1], path: m[2], id: m[3] || 'unknown' };
  }
  const host = head.replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
  return { head, host: host || 'discord.com', path: '/api/webhooks/', id: 'masked' };
}

function formatAgo(ms) {
  if (!ms || !Number.isFinite(ms)) return 'Never';
  const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (diffSec < 45) return 'Just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 48) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

function formatClock(ms) {
  if (!ms || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

function parseLogEntry(rawLine, idx) {
  const safe = maskSecrets(rawLine);
  let rest = safe.trim();
  let timestamp = '';

  const tsMatch = rest.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(.*)$/);
  if (tsMatch) {
    timestamp = tsMatch[2].replace(/Z$/, '');
    rest = tsMatch[3];
  }

  let level = 'INFO';
  const lvlMatch = rest.match(/^(INFO|WARN|WARNING|ERROR)\b[:\s-]*(.*)$/i);
  if (lvlMatch) {
    const rawLvl = lvlMatch[1].toUpperCase();
    level = rawLvl === 'WARNING' ? 'WARN' : rawLvl;
    rest = lvlMatch[2];
  }

  let message = rest;
  let details = null;
  const braceIdx = rest.indexOf(' {');
  if (braceIdx >= 0 && rest.endsWith('}')) {
    const candidate = rest.slice(braceIdx + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        message = rest.slice(0, braceIdx);
        details = parsed;
      }
    } catch {
      // keep raw message
    }
  }

  return {
    id: `${idx}-${timestamp}-${message.slice(0, 24)}`,
    timestamp,
    level,
    message,
    details,
  };
}

const CATEGORY_META = {
  household: {
    label: 'HOUSEHOLD ACCESS',
    badgeClass: 'bg-rose-500/10 text-rose-700 border-rose-500/30 dark:bg-rose-500/15 dark:text-rose-300',
  },
  verification: {
    label: 'OTP / CODE',
    badgeClass: 'bg-teal-500/10 text-teal-700 border-teal-500/30 dark:bg-teal-500/15 dark:text-teal-300',
  },
  security: {
    label: 'SECURITY ALERT',
    badgeClass: 'bg-amber-500/10 text-amber-800 border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300',
  },
  billing: {
    label: 'BILLING',
    badgeClass: 'bg-indigo-500/10 text-indigo-700 border-indigo-500/30 dark:bg-indigo-500/15 dark:text-indigo-300',
  },
  general: {
    label: 'NETFLIX MAIL',
    badgeClass: 'bg-slate-500/10 text-slate-700 border-slate-500/30 dark:bg-slate-500/15 dark:text-slate-300',
  },
};

export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem('nf:theme') || 'dark');
  const [autoPoll, setAutoPoll] = useState(true);
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);

  // Run state
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState(() => {
    try {
      const raw = localStorage.getItem(RUN_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  // Channel form & actions
  const [webhookInput, setWebhookInput] = useState('');
  const [showWebhookSecret, setShowWebhookSecret] = useState(false);
  const [channelBusy, setChannelBusy] = useState(false);
  const [channelFeedback, setChannelFeedback] = useState(null);
  const [confirmRemoveIdx, setConfirmRemoveIdx] = useState(null);
  const [pingingIdx, setPingingIdx] = useState(null);

  // Delete Discord messages state
  const [confirmDeletePosts, setConfirmDeletePosts] = useState(false);
  const [deletingPosts, setDeletingPosts] = useState(false);
  const [deleteFeedback, setDeleteFeedback] = useState(null);

  // UI inspectors
  const [expandedSlotId, setExpandedSlotId] = useState(null);
  const [copiedText, setCopiedText] = useState(null);
  const [logFilter, setLogFilter] = useState('ALL');
  const [logSearch, setLogSearch] = useState('');

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'light') {
      root.classList.add('light');
      root.classList.remove('dark');
    } else {
      root.classList.add('dark');
      root.classList.remove('light');
    }
    localStorage.setItem('nf:theme', theme);
  }, [theme]);

  const saveLastRun = useCallback((record) => {
    setLastRun(record);
    try {
      localStorage.setItem(RUN_STORAGE_KEY, JSON.stringify(record));
    } catch {
      // ignore storage errors
    }
  }, []);

  const fetchSnapshot = useCallback(async () => {
    try {
      const res = await fetch('/api/snapshot', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setSnapshot(data);
      setFetchError(null);
      setLastSyncedAt(Date.now());
    } catch (err) {
      setFetchError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSnapshot();
  }, [fetchSnapshot]);

  useEffect(() => {
    if (!autoPoll) return undefined;
    const timer = setInterval(fetchSnapshot, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoPoll, fetchSnapshot]);

  const handleCopy = useCallback((text, label) => {
    navigator.clipboard?.writeText(text);
    setCopiedText(label);
    setTimeout(() => setCopiedText(null), 2000);
  }, []);

  const handleRunNow = async () => {
    if (running) return;
    setRunning(true);
    setDeleteFeedback(null);
    try {
      const res = await fetch('/api/run', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) {
        const errMsg = maskSecrets(data.error || 'Run failed');
        saveLastRun({
          kind: 'failed',
          sent: 0,
          skipped: 0,
          message: errMsg,
          code: /invalid_grant/i.test(errMsg) ? 'invalid_grant' : null,
          at: Date.now(),
        });
      } else {
        const sent = Number(data.sent) || 0;
        const skipped = Number(data.skipped) || 0;
        const kind = data.outcome || (sent > 0 ? 'posted' : skipped > 0 ? 'skipped' : 'nothing');
        saveLastRun({
          kind,
          sent,
          skipped,
          message: '',
          code: null,
          at: Date.now(),
        });
      }
      await fetchSnapshot();
    } catch (err) {
      saveLastRun({
        kind: 'failed',
        sent: 0,
        skipped: 0,
        message: maskSecrets(err.message),
        code: null,
        at: Date.now(),
      });
    } finally {
      setRunning(false);
    }
  };

  const handleAddWebhook = async (e) => {
    e.preventDefault();
    const url = webhookInput.trim();
    if (!url) {
      setChannelFeedback({ tone: 'err', text: 'Paste a Discord webhook URL first.' });
      return;
    }
    if (!url.startsWith('https://')) {
      setChannelFeedback({ tone: 'err', text: 'Webhook URL must start with https://' });
      return;
    }

    setChannelBusy(true);
    setChannelFeedback(null);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', webhookUrl: url }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setChannelFeedback({ tone: 'err', text: maskSecrets(data.error || 'Could not add channel') });
      } else {
        setWebhookInput('');
        setShowWebhookSecret(false);
        setChannelFeedback({ tone: 'ok', text: `Channel added (${data.count}/${MAX_CHANNELS} active).` });
        await fetchSnapshot();
      }
    } catch (err) {
      setChannelFeedback({ tone: 'err', text: err.message });
    } finally {
      setChannelBusy(false);
    }
  };

  const handleRemoveWebhook = async (index) => {
    setChannelBusy(true);
    setChannelFeedback(null);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', index }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setChannelFeedback({ tone: 'err', text: maskSecrets(data.error || 'Could not remove channel') });
      } else {
        setConfirmRemoveIdx(null);
        setChannelFeedback({ tone: 'ok', text: `Channel #${index + 1} removed.` });
        await fetchSnapshot();
      }
    } catch (err) {
      setChannelFeedback({ tone: 'err', text: err.message });
    } finally {
      setChannelBusy(false);
    }
  };

  const handleTestWebhook = async (index) => {
    setPingingIdx(index);
    setChannelFeedback(null);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', index }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setChannelFeedback({ tone: 'err', text: maskSecrets(data.error || 'Test ping failed') });
      } else {
        setChannelFeedback({ tone: 'ok', text: data.message || `Diagnostic ping sent to Channel #${index + 1}` });
        await fetchSnapshot();
      }
    } catch (err) {
      setChannelFeedback({ tone: 'err', text: err.message });
    } finally {
      setPingingIdx(null);
    }
  };

  const handleDeleteSentMessages = async () => {
    setDeletingPosts(true);
    setDeleteFeedback(null);
    try {
      const res = await fetch('/api/delete-messages', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) {
        setDeleteFeedback({ tone: 'err', text: maskSecrets(data.error || 'Delete failed') });
      } else {
        setConfirmDeletePosts(false);
        setDeleteFeedback({
          tone: data.failed > 0 ? 'warn' : 'ok',
          text: data.message || `Deleted ${data.deleted} message(s) from Discord.`,
        });
        await fetchSnapshot();
      }
    } catch (err) {
      setDeleteFeedback({ tone: 'err', text: err.message });
    } finally {
      setDeletingPosts(false);
    }
  };

  // Derived view models
  const config = snapshot?.config || {};
  const status = snapshot?.status || {};
  const checkpoint = snapshot?.checkpoint || {};
  const rawLogs = snapshot?.logs || [];

  const channels = useMemo(() => {
    const list = Array.isArray(config.discordWebhookUrls) ? config.discordWebhookUrls : [];
    return list.map(describeWebhookChannel);
  }, [config.discordWebhookUrls]);

  const parsedLogs = useMemo(() => rawLogs.map(parseLogEntry), [rawLogs]);

  const filteredLogs = useMemo(() => {
    return parsedLogs.filter((entry) => {
      if (logFilter === 'WARN' && entry.level !== 'WARN' && entry.level !== 'ERROR') return false;
      if (logFilter === 'ERROR' && entry.level !== 'ERROR') return false;
      if (logSearch.trim()) {
        const needle = logSearch.toLowerCase();
        const hay = `${entry.message} ${JSON.stringify(entry.details || {})}`.toLowerCase();
        return hay.includes(needle);
      }
      return true;
    });
  }, [parsedLogs, logFilter, logSearch]);

  // Build the 5-slot deduplication window items
  const windowSize = Number(config.forwardLatestCount) || 5;
  const windowSlots = useMemo(() => {
    const richMessages = Array.isArray(checkpoint.windowMessages) ? checkpoint.windowMessages : [];
    const fallbackIds = Array.isArray(checkpoint.lastOnceLatestIds) ? checkpoint.lastOnceLatestIds : [];

    // Map any known subjects from logs for legacy checkpoints
    const logSubjects = new Map();
    for (const entry of parsedLogs) {
      if (entry.details?.id && entry.details?.subject && !logSubjects.has(entry.details.id)) {
        logSubjects.set(entry.details.id, entry.details.subject);
      }
    }

    const items = richMessages.length > 0
      ? richMessages
      : fallbackIds.map((id) => ({
          id,
          subject: logSubjects.get(id) || 'Forwarded Netflix Email',
          from: 'Netflix <info@mailer.netflix.com>',
          internalDate: null,
          category: 'general',
          extractedCode: null,
          ctaUrl: null,
          ctaLabel: null,
          permalink: `https://mail.google.com/mail/u/0/#inbox/${id}`,
        }));

    const slots = [];
    for (let i = 0; i < windowSize; i += 1) {
      const msg = items[i] || null;
      slots.push({
        slotNumber: i + 1,
        message: msg,
      });
    }
    return slots;
  }, [checkpoint.windowMessages, checkpoint.lastOnceLatestIds, parsedLogs, windowSize]);

  const activePosts = Array.isArray(checkpoint.lastSentDiscordMessages)
    ? checkpoint.lastSentDiscordMessages
    : [];

  const postsByChannelIndex = useMemo(() => {
    const counts = new Map();
    for (const post of activePosts) {
      if (Number.isInteger(post.webhookIndex)) {
        counts.set(post.webhookIndex, (counts.get(post.webhookIndex) || 0) + 1);
      }
    }
    return counts;
  }, [activePosts]);

  // Determine effective last run display
  const effectiveOutcome = useMemo(() => {
    if (running || status.isRunning) {
      return {
        kind: 'running',
        title: 'Polling Gmail & evaluating 5-email deduplication window…',
        subtitle: 'Checking latest matching Netflix messages and syncing with Discord webhooks.',
        tone: 'teal',
      };
    }

    const ckptRunAt = checkpoint.lastOnceRunAt ? new Date(checkpoint.lastOnceRunAt).getTime() : null;
    const outcomeKind = lastRun?.kind || checkpoint.lastOutcome || (ckptRunAt ? 'recorded' : 'idle');

    if (outcomeKind === 'failed') {
      return {
        kind: 'failed',
        title: lastRun?.code === 'invalid_grant'
          ? 'Gmail OAuth Token Expired or Revoked (invalid_grant)'
          : 'Last Poll Cycle Encountered an Error',
        subtitle: lastRun?.message || 'Inspect the error output below and retry.',
        code: lastRun?.code,
        at: lastRun?.at || ckptRunAt,
        tone: 'rose',
      };
    }

    if (outcomeKind === 'posted') {
      const count = lastRun?.sent || windowSlots.filter((s) => s.message).length || 1;
      return {
        kind: 'posted',
        title: `Forwarded ${count} Netflix email${count === 1 ? '' : 's'} to ${channels.length || 1} Discord channel${channels.length === 1 ? '' : 's'}`,
        subtitle: 'Previous Discord messages from the earlier window were cleaned up automatically before posting.',
        at: lastRun?.at || ckptRunAt,
        tone: 'emerald',
      };
    }

    if (outcomeKind === 'skipped') {
      return {
        kind: 'skipped',
        title: `Skipped — Latest ${windowSize} emails match the previous run window`,
        subtitle: 'Duplicate-window protection prevented re-posting the same 5 emails to Discord.',
        at: lastRun?.at || ckptRunAt,
        tone: 'amber',
      };
    }

    if (outcomeKind === 'nothing') {
      return {
        kind: 'nothing',
        title: 'No matching Netflix emails found in the query window',
        subtitle: `No messages matched "${config.gmailQuery || 'in:inbox newer_than:1d'}" from "${config.gmailSenderFilter || 'netflix.com'}".`,
        at: lastRun?.at || ckptRunAt,
        tone: 'slate',
      };
    }

    if (ckptRunAt) {
      return {
        kind: 'recorded',
        title: `Checkpoint initialized • ${windowSlots.filter((s) => s.message).length} email(s) in current window`,
        subtitle: 'Trigger a manual run to evaluate incoming Gmail messages immediately.',
        at: ckptRunAt,
        tone: 'teal',
      };
    }

    return {
      kind: 'idle',
      title: 'Ready for Initial Poll Cycle',
      subtitle: 'Click "Run Now" to fetch the latest 5 Netflix emails from Gmail and forward them to Discord.',
      at: null,
      tone: 'slate',
    };
  }, [running, status.isRunning, lastRun, checkpoint, windowSlots, channels.length, windowSize, config]);

  const systemStatusPill = useMemo(() => {
    if (fetchError) {
      return {
        label: 'OFFLINE',
        dot: 'bg-rose-500',
        classes: 'bg-rose-500/10 text-rose-700 border-rose-500/30 dark:bg-rose-500/15 dark:text-rose-300',
      };
    }
    if (running || status.isRunning) {
      return {
        label: 'RUNNING POLL',
        dot: 'bg-teal-500 dark:bg-teal-400 animate-ping',
        classes: 'bg-teal-500/10 text-teal-800 border-teal-500/30 dark:bg-teal-500/15 dark:text-teal-300',
      };
    }
    if (effectiveOutcome.code === 'invalid_grant') {
      return {
        label: 'GMAIL AUTH EXPIRED',
        dot: 'bg-rose-500',
        classes: 'bg-rose-500/10 text-rose-700 border-rose-500/30 dark:bg-rose-500/15 dark:text-rose-300',
      };
    }
    if (channels.length === 0) {
      return {
        label: 'NO WEBHOOKS',
        dot: 'bg-amber-500 dark:bg-amber-400',
        classes: 'bg-amber-500/10 text-amber-800 border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300',
      };
    }
    return {
      label: 'ONLINE • READY',
      dot: 'bg-emerald-500 dark:bg-emerald-400',
      classes: 'bg-emerald-500/10 text-emerald-800 border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300',
    };
  }, [fetchError, running, status.isRunning, effectiveOutcome.code, channels.length]);

  return (
    <div className="min-h-screen pb-16">
      {/* Top Broadcast Telemetry Header */}
      <header className="sticky top-0 z-30 border-b border-[var(--border-subtle)] bg-[var(--bg-canvas)]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-500 shadow-inner">
              <Radio className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-display text-xl font-extrabold tracking-wider uppercase sm:text-2xl text-[var(--text-primary)]">
                  Netflix <span className="text-teal-600 dark:text-teal-400">→</span> Discord
                </h1>
                <span className="hidden rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-tabular text-[11px] font-semibold text-[var(--text-secondary)] sm:inline-block">
                  v2.0 TELEMETRY
                </span>
              </div>
              <p className="text-xs text-[var(--text-secondary)]">
                Smart Gmail-to-Discord Household & Verification Forwarder
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Storage & Region Badge */}
            <div className="hidden items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 font-mono-tabular text-xs text-[var(--text-secondary)] md:flex shadow-xs">
              <Database className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
              <span>{status.storageMode === 'upstash-redis' ? 'UPSTASH REDIS' : 'LOCAL STORE'}</span>
              <span className="text-[var(--text-muted)]">•</span>
              <span className="text-teal-700 dark:text-teal-400 font-bold uppercase">{status.region || 'sin1'}</span>
            </div>

            {/* System Status Pill */}
            <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono-tabular text-xs font-semibold ${systemStatusPill.classes}`}>
              <span className={`h-2 w-2 rounded-full ${systemStatusPill.dot}`} />
              <span>{systemStatusPill.label}</span>
            </div>

            {/* Auto-poll toggle */}
            <button
              type="button"
              onClick={() => setAutoPoll((v) => !v)}
              title={autoPoll ? 'Auto-sync active (10s). Click to pause.' : 'Auto-sync paused. Click to resume.'}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 font-mono-tabular text-xs text-[var(--text-secondary)] transition hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] cursor-pointer shadow-xs"
            >
              {autoPoll ? <RefreshCw className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" /> : <Pause className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />}
              <span className="hidden sm:inline">{autoPoll ? '10s Sync' : 'Paused'}</span>
            </button>

            {/* Manual Refresh */}
            <button
              type="button"
              onClick={fetchSnapshot}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs font-semibold text-[var(--text-primary)] transition hover:border-[var(--border-strong)] cursor-pointer shadow-xs"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Sync</span>
            </button>

            {/* Theme Switch */}
            <button
              type="button"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              aria-label="Toggle color theme"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] transition hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] cursor-pointer shadow-xs"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto mt-6 max-w-7xl space-y-6 px-4 sm:px-6">
        {/* Interactive 4-Stop Pipeline Strip */}
        <section
          aria-label="Forwarding Pipeline Route"
          className="relative overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 shadow-lg"
        >
          {/* Top connecting flow bar */}
          <div
            className={`mb-5 h-1 w-full rounded-full ${
              running || status.isRunning ? 'animate-route-flow' : 'bg-[var(--border-subtle)]'
            }`}
          />

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:items-center">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:col-span-9 lg:grid-cols-4">
              {/* Stop 1: Source */}
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3.5 shadow-xs">
                <div className="flex items-center justify-between">
                  <span className="font-display text-[11px] font-bold tracking-widest text-[var(--text-muted)] uppercase">
                    01 // Source
                  </span>
                  <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono-tabular text-[10px] font-bold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
                    GMAIL API v1
                  </span>
                </div>
                <p className="mt-1 font-display text-base font-bold text-[var(--text-primary)]">Gmail Inbox</p>
                <code className="mt-1 block truncate font-mono-tabular text-xs font-semibold text-teal-700 dark:text-teal-400">
                  {config.gmailQuery || 'in:inbox newer_than:1d'}
                </code>
                <p className="mt-1.5 font-mono-tabular text-[11px] text-[var(--text-muted)]">
                  Inspects up to {config.gmailFetchLimit || 25} recent msgs
                </p>
              </div>

              {/* Stop 2: Filter & Smart Parser */}
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3.5 shadow-xs">
                <div className="flex items-center justify-between">
                  <span className="font-display text-[11px] font-bold tracking-widest text-[var(--text-muted)] uppercase">
                    02 // Smart Parser
                  </span>
                  <span className="inline-flex items-center gap-1 rounded bg-rose-500/10 px-1.5 py-0.5 font-mono-tabular text-[10px] font-bold text-rose-700 dark:bg-rose-500/15 dark:text-rose-400">
                    <Sparkles className="h-2.5 w-2.5" /> OTP + CTA
                  </span>
                </div>
                <p className="mt-1 font-display text-base font-bold text-[var(--text-primary)]">Sender Filter</p>
                <code className="mt-1 block truncate font-mono-tabular text-xs font-semibold text-rose-700 dark:text-rose-400">
                  @{config.gmailSenderFilter || 'netflix.com'}
                </code>
                <p className="mt-1.5 font-mono-tabular text-[11px] text-[var(--text-muted)]">
                  Extracts codes & household links
                </p>
              </div>

              {/* Stop 3: 5-Email Window */}
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3.5 shadow-xs">
                <div className="flex items-center justify-between">
                  <span className="font-display text-[11px] font-bold tracking-widest text-[var(--text-muted)] uppercase">
                    03 // Dedup Window
                  </span>
                  <span className="font-mono-tabular text-[11px] font-bold text-teal-700 dark:text-teal-400">
                    {windowSlots.filter((s) => s.message).length}/{windowSize} SLOTS
                  </span>
                </div>
                <p className="mt-1 font-display text-base font-bold text-[var(--text-primary)]">Latest {windowSize} Emails</p>
                <div className="mt-2 flex gap-1.5" aria-hidden="true">
                  {windowSlots.map((slot) => (
                    <span
                      key={slot.slotNumber}
                      className={`h-2.5 flex-1 rounded-xs border ${
                        slot.message
                          ? 'border-teal-600 bg-teal-600 dark:border-teal-400 dark:bg-teal-400/80'
                          : 'border-[var(--border-strong)] bg-transparent'
                      }`}
                    />
                  ))}
                </div>
                <p className="mt-1.5 font-mono-tabular text-[11px] text-[var(--text-muted)]">
                  Skips when all {windowSize} IDs match
                </p>
              </div>

              {/* Stop 4: Discord Fan-Out */}
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3.5 shadow-xs">
                <div className="flex items-center justify-between">
                  <span className="font-display text-[11px] font-bold tracking-widest text-[var(--text-muted)] uppercase">
                    04 // Deliver
                  </span>
                  <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 font-mono-tabular text-[10px] font-bold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                    WEBHOOKS
                  </span>
                </div>
                <p className="mt-1 font-display text-base font-bold text-[var(--text-primary)]">Discord Channels</p>
                <p className="mt-1 font-mono-tabular text-xs font-bold text-indigo-700 dark:text-indigo-400">
                  {channels.length} / {MAX_CHANNELS} Active Endpoints
                </p>
                <p className="mt-1.5 font-mono-tabular text-[11px] text-[var(--text-muted)]">
                  {activePosts.length} tracked msg(s) live
                </p>
              </div>
            </div>

            {/* Run Trigger CTA */}
            <div className="flex flex-col justify-center gap-2 lg:col-span-3">
              <button
                type="button"
                disabled={running || status.isRunning || channels.length === 0}
                onClick={handleRunNow}
                className="flex w-full items-center justify-center gap-2.5 rounded-lg bg-teal-600 px-5 py-4 font-display text-lg font-extrabold tracking-wider text-white hover:bg-teal-500 dark:bg-teal-500 dark:text-slate-950 dark:hover:bg-teal-400 uppercase shadow-md shadow-teal-500/20 transition disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 dark:disabled:bg-slate-800 dark:disabled:text-slate-500 disabled:shadow-none cursor-pointer"
              >
                <Play className="h-5 w-5 fill-current" />
                <span>{running || status.isRunning ? 'Running Poll…' : 'Run Poll Now'}</span>
              </button>
              <div className="flex items-center justify-between px-1 font-mono-tabular text-[11px] text-[var(--text-muted)]">
                <span>Last synced: {lastSyncedAt ? formatClock(lastSyncedAt) : '…'}</span>
                <span>{checkpoint.lastOnceRunAt ? `Last run ${formatAgo(new Date(checkpoint.lastOnceRunAt).getTime())}` : 'No runs yet'}</span>
              </div>
            </div>
          </div>
        </section>

        {/* Main 7 / 5 Control Room Grid */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-start">
          {/* Left Column (7 cols): Last Run Verdict & 5-Slot Window Inspector */}
          <div className="space-y-6 lg:col-span-7">
            {/* Last Run Verdict Banner */}
            <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 shadow-lg">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-3.5">
                <div className="flex items-center gap-2">
                  <h2 className="font-display text-base font-bold tracking-wider uppercase text-[var(--text-primary)]">
                    Last Run Telemetry
                  </h2>
                  {effectiveOutcome.at && (
                    <span className="font-mono-tabular text-xs text-[var(--text-muted)]">
                      • {formatAgo(effectiveOutcome.at)} ({formatClock(effectiveOutcome.at)})
                    </span>
                  )}
                </div>
                <span className="font-mono-tabular text-xs text-[var(--text-secondary)]">
                  Sent Today: <strong className="text-[var(--text-primary)]">{checkpoint.sentCount ?? 0}</strong>
                </span>
              </div>

              <div
                className={`mt-4 rounded-lg border p-4 ${
                  effectiveOutcome.tone === 'emerald'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-950 dark:text-emerald-100'
                    : effectiveOutcome.tone === 'amber'
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-100'
                    : effectiveOutcome.tone === 'rose'
                    ? 'border-rose-500/30 bg-rose-500/10 text-rose-950 dark:text-rose-100'
                    : effectiveOutcome.tone === 'teal'
                    ? 'border-teal-500/30 bg-teal-500/10 text-teal-950 dark:text-teal-100'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-sunken)] text-[var(--text-primary)]'
                }`}
              >
                <div className="flex items-start gap-3">
                  {effectiveOutcome.tone === 'emerald' && <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />}
                  {effectiveOutcome.tone === 'amber' && <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />}
                  {effectiveOutcome.tone === 'rose' && <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600 dark:text-rose-400" />}
                  {(effectiveOutcome.tone === 'teal' || effectiveOutcome.tone === 'slate') && (
                    <Radio className="mt-0.5 h-5 w-5 shrink-0 text-teal-600 dark:text-teal-400" />
                  )}
                  <div className="min-w-0 flex-1">
                    <h3 className="font-display text-lg font-bold leading-snug">
                      {effectiveOutcome.title}
                    </h3>
                    <p className="mt-1 text-sm text-[var(--text-secondary)] break-words">
                      {effectiveOutcome.subtitle}
                    </p>

                    {effectiveOutcome.code === 'invalid_grant' && (
                      <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-50/90 dark:bg-slate-950/60 p-3 text-xs shadow-xs">
                        <p className="font-bold text-rose-800 dark:text-rose-300">
                          Quick Fix — Refresh & Upload Gmail OAuth Token:
                        </p>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 font-mono-tabular">
                          <code className="text-teal-700 dark:text-teal-300 font-semibold">npm run token:refresh && npm run deploy</code>
                          <button
                            type="button"
                            onClick={() => handleCopy('npm run token:refresh && npm run deploy', 'cmd')}
                            className="inline-flex items-center gap-1 rounded bg-teal-500/20 px-2 py-1 text-[11px] font-bold text-teal-800 dark:text-teal-300 hover:bg-teal-500/30 cursor-pointer"
                          >
                            {copiedText === 'cmd' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                            <span>{copiedText === 'cmd' ? 'Copied' : 'Copy Command'}</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* 5-Slot Deduplication Window Inspector */}
              <div className="mt-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-display text-sm font-bold tracking-wider uppercase text-[var(--text-primary)]">
                      5-Slot Deduplication Window Inspector
                    </h3>
                    <p className="text-xs text-[var(--text-secondary)]">
                      Ordered oldest (#1) to newest (#{windowSize}). Click any slot to preview its Discord embed & extracted Netflix artifacts.
                    </p>
                  </div>
                  <span className="rounded border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1 font-mono-tabular text-xs text-[var(--text-secondary)]">
                    {windowSlots.filter((s) => s.message).length} / {windowSize} slots populated
                  </span>
                </div>

                <div className="mt-3 divide-y divide-[var(--border-subtle)] overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
                  {windowSlots.map(({ slotNumber, message }) => {
                    if (!message) {
                      return (
                        <div
                          key={slotNumber}
                          className="flex items-center justify-between px-4 py-3 text-xs text-[var(--text-muted)]"
                        >
                          <div className="flex items-center gap-3">
                            <span className="font-mono-tabular font-bold text-[var(--text-secondary)]">0{slotNumber}</span>
                            <span>Empty window slot — waiting for matching Netflix email</span>
                          </div>
                          <span className="rounded border border-[var(--border-subtle)] px-2 py-0.5 font-mono-tabular text-[10px] uppercase text-[var(--text-muted)]">
                            VACANT
                          </span>
                        </div>
                      );
                    }

                    const cat = CATEGORY_META[message.category] || CATEGORY_META.general;
                    const isExpanded = expandedSlotId === message.id;

                    return (
                      <div key={message.id || slotNumber} className="transition hover:bg-[var(--bg-elevated)]/50">
                        <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5">
                          <div className="flex min-w-0 flex-1 items-start gap-3">
                            <span className="mt-0.5 rounded bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-tabular text-xs font-bold text-teal-700 dark:text-teal-400 border border-[var(--border-subtle)]">
                              0{slotNumber}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={`rounded border px-1.5 py-0.5 font-mono-tabular text-[10px] font-bold ${cat.badgeClass}`}>
                                  {cat.label}
                                </span>
                                <code className="font-mono-tabular text-[11px] text-[var(--text-muted)]">
                                  id:{message.id}
                                </code>
                                {message.internalDate && (
                                  <span className="font-mono-tabular text-[11px] text-[var(--text-muted)]">
                                    • {formatAgo(message.internalDate)}
                                  </span>
                                )}
                              </div>

                              <p className="mt-1 font-semibold text-[var(--text-primary)] leading-snug">
                                {message.subject}
                              </p>

                              {/* Extracted Code or CTA Quick Bar */}
                              {(message.extractedCode || message.ctaUrl) && (
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                  {message.extractedCode && (
                                    <button
                                      type="button"
                                      onClick={() => handleCopy(message.extractedCode, `code-${message.id}`)}
                                      className="inline-flex items-center gap-1.5 rounded border border-teal-500/30 bg-teal-500/10 px-2.5 py-1 font-mono-tabular text-xs font-bold text-teal-800 dark:border-teal-500/40 dark:bg-teal-500/15 dark:text-teal-300 hover:bg-teal-500/20 cursor-pointer shadow-2xs"
                                    >
                                      <KeyRound className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                                      <span>CODE: {message.extractedCode}</span>
                                      {copiedText === `code-${message.id}` ? (
                                        <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                                      ) : (
                                        <Copy className="h-3 w-3 opacity-75" />
                                      )}
                                    </button>
                                  )}

                                  {message.ctaUrl && (
                                    <a
                                      href={message.ctaUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="inline-flex items-center gap-1.5 rounded border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-semibold text-rose-800 dark:border-rose-500/40 dark:bg-rose-500/15 dark:text-rose-300 hover:bg-rose-500/20 shadow-2xs"
                                    >
                                      <ExternalLink className="h-3.5 w-3.5" />
                                      <span>{message.ctaLabel || 'Open Netflix Link'}</span>
                                    </a>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <a
                              href={message.permalink}
                              target="_blank"
                              rel="noreferrer"
                              title="Open in Gmail"
                              className="inline-flex items-center gap-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] shadow-2xs"
                            >
                              <Mail className="h-3.5 w-3.5" />
                              <span className="hidden sm:inline">Gmail</span>
                            </a>

                            <button
                              type="button"
                              onClick={() => setExpandedSlotId(isExpanded ? null : message.id)}
                              className="inline-flex items-center gap-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 text-xs font-semibold text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] cursor-pointer shadow-2xs"
                            >
                              <span>Preview</span>
                              {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                            </button>
                          </div>
                        </div>

                        {/* Expandable Discord Embed Preview */}
                        {isExpanded && (
                          <div className="border-t border-[var(--border-subtle)] bg-[var(--bg-canvas)]/70 px-4 py-3.5">
                            <div className="rounded-md border-l-4 border-rose-600 bg-[#2b2d31] p-3.5 text-slate-100 shadow-inner">
                              <div className="flex items-center justify-between text-xs text-slate-400">
                                <span className="font-bold text-white">Netflix Forwarder</span>
                                <span className="rounded bg-indigo-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                                  APP
                                </span>
                              </div>
                              <p className="mt-1.5 font-bold text-sky-400">{message.subject}</p>
                              <p className="mt-1 text-xs text-slate-300 leading-relaxed">
                                {message.snippet || 'Forwarded email body preview…'}
                              </p>
                              <div className="mt-2.5 grid grid-cols-2 gap-2 text-xs">
                                <div>
                                  <span className="block font-bold text-slate-400">Sender</span>
                                  <span className="text-slate-200">{message.from}</span>
                                </div>
                                <div>
                                  <span className="block font-bold text-slate-400">Category</span>
                                  <span className="font-mono-tabular text-slate-200 uppercase">
                                    {message.category || 'general'}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          </div>

          {/* Right Column (5 cols): Discord Channel Manager & Checkpoint State */}
          <div className="space-y-6 lg:col-span-5">
            {/* Discord Channels Card */}
            <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 shadow-lg">
              <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-3.5">
                <div>
                  <h2 className="font-display text-base font-bold tracking-wider uppercase text-[var(--text-primary)]">
                    Discord Webhook Channels
                  </h2>
                  <p className="text-xs text-[var(--text-secondary)]">
                    Every run fans out to all configured channels simultaneously.
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="flex gap-1" aria-hidden="true">
                    {Array.from({ length: MAX_CHANNELS }).map((_, idx) => (
                      <span
                        key={idx}
                        className={`h-2.5 w-3.5 rounded-xs border ${
                          idx < channels.length
                            ? 'border-indigo-600 bg-indigo-600 dark:border-indigo-400 dark:bg-indigo-500'
                            : 'border-[var(--border-strong)] bg-transparent'
                        }`}
                      />
                    ))}
                  </div>
                  <span className="font-mono-tabular text-xs font-semibold text-[var(--text-secondary)]">
                    {channels.length}/{MAX_CHANNELS}
                  </span>
                </div>
              </div>

              {/* Channel List */}
              <div className="mt-4 divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
                {channels.length === 0 ? (
                  <div className="p-4 text-center text-sm text-[var(--text-secondary)]">
                    No Discord webhook channels configured yet. Add one below to enable forwarding.
                  </div>
                ) : (
                  channels.map((chan, idx) => {
                    const liveCount = postsByChannelIndex.get(idx) || 0;
                    const isConfirming = confirmRemoveIdx === idx;
                    const isPinging = pingingIdx === idx;

                    return (
                      <div key={`${chan.id}-${idx}`} className="p-3.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 font-mono-tabular text-xs font-bold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-400">
                                #{idx + 1}
                              </span>
                              <code className="truncate font-mono-tabular text-xs text-[var(--text-primary)]">
                                {chan.host}
                                <span className="text-[var(--text-muted)]">/webhooks/</span>
                                <span className="text-teal-700 dark:text-teal-400 font-semibold">{chan.id}</span>
                                <span className="text-[var(--text-muted)]">/••••</span>
                              </code>
                            </div>
                            <p className="mt-1 font-mono-tabular text-[11px] text-[var(--text-muted)]">
                              {liveCount > 0
                                ? `${liveCount} active forwarded post(s) tracked in this channel`
                                : 'Ready to receive embeds'}
                            </p>
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={isPinging || channelBusy}
                              onClick={() => handleTestWebhook(idx)}
                              title="Send diagnostic test ping embed to this Discord channel"
                              className="inline-flex items-center gap-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs font-semibold text-teal-700 dark:text-teal-400 transition hover:border-teal-500/50 hover:bg-teal-500/10 disabled:opacity-50 cursor-pointer shadow-2xs"
                            >
                              <Send className="h-3 w-3" />
                              <span>{isPinging ? 'Pinging…' : 'Ping'}</span>
                            </button>

                            {channels.length > 1 && (
                              <button
                                type="button"
                                disabled={channelBusy}
                                onClick={() => setConfirmRemoveIdx(isConfirming ? null : idx)}
                                className="inline-flex items-center gap-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1.5 text-xs text-rose-700 dark:text-rose-400 transition hover:border-rose-500/50 hover:bg-rose-500/10 cursor-pointer shadow-2xs"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </div>

                        {isConfirming && (
                          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded border border-rose-500/30 bg-rose-50/90 dark:bg-rose-500/10 px-3 py-2 text-xs">
                            <span className="text-rose-900 dark:text-rose-200 font-medium">Remove Channel #{idx + 1} (ID {chan.id})?</span>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => handleRemoveWebhook(idx)}
                                className="rounded bg-rose-600 px-2.5 py-1 font-semibold text-white hover:bg-rose-500 cursor-pointer"
                              >
                                Confirm Remove
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmRemoveIdx(null)}
                                className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1 text-[var(--text-secondary)] cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* Add Channel Form */}
              <form onSubmit={handleAddWebhook} className="mt-4 space-y-2.5 border-t border-dashed border-[var(--border-subtle)] pt-4">
                <label htmlFor="webhookUrlInput" className="block text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">
                  Add Discord Webhook Endpoint
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      id="webhookUrlInput"
                      type={showWebhookSecret ? 'text' : 'password'}
                      value={webhookInput}
                      disabled={channelBusy || channels.length >= MAX_CHANNELS}
                      onChange={(e) => setWebhookInput(e.target.value)}
                      placeholder="https://discord.com/api/webhooks/..."
                      className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-sunken)] py-2 pr-9 pl-3 font-mono-tabular text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-teal-500 focus:outline-none disabled:opacity-50"
                    />
                    <button
                      type="button"
                      onClick={() => setShowWebhookSecret((s) => !s)}
                      aria-label={showWebhookSecret ? 'Hide webhook URL' : 'Show webhook URL'}
                      className="absolute top-1/2 right-2.5 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                    >
                      {showWebhookSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <button
                    type="submit"
                    disabled={channelBusy || channels.length >= MAX_CHANNELS}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-bold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer shadow-xs"
                  >
                    <Plus className="h-4 w-4" />
                    <span>Add</span>
                  </button>
                </div>
                {channelFeedback && (
                  <p
                    className={`text-xs font-semibold ${
                      channelFeedback.tone === 'ok' ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'
                    }`}
                  >
                    {channelFeedback.text}
                  </p>
                )}
                <p className="text-[11px] text-[var(--text-muted)]">
                  Persisted to Upstash Redis (<code className="text-teal-700 dark:text-teal-400 font-semibold">upstash-kv-violet-village</code>) on Vercel or <code className="text-teal-700 dark:text-teal-400 font-semibold">.env</code> locally.
                </p>
              </form>
            </section>

            {/* Checkpoint & Active Discord Post Cleanup */}
            <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 shadow-lg">
              <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3.5">
                <h2 className="font-display text-base font-bold tracking-wider uppercase text-[var(--text-primary)]">
                  Checkpoint State
                </h2>
                <span className="font-mono-tabular text-xs text-[var(--text-muted)]">
                  Day: {checkpoint.day || '—'}
                </span>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-3.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3.5">
                <div>
                  <dt className="text-xs text-[var(--text-muted)]">Last Poll Run</dt>
                  <dd className="mt-0.5 font-mono-tabular text-sm font-bold text-[var(--text-primary)]">
                    {checkpoint.lastOnceRunAt
                      ? formatAgo(new Date(checkpoint.lastOnceRunAt).getTime())
                      : 'Never'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--text-muted)]">Last Post Sent</dt>
                  <dd className="mt-0.5 font-mono-tabular text-sm font-bold text-[var(--text-primary)]">
                    {checkpoint.lastSuccessAt
                      ? formatAgo(new Date(checkpoint.lastSuccessAt).getTime())
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--text-muted)]">Window Emails Saved</dt>
                  <dd className="mt-0.5 font-mono-tabular text-sm font-bold text-teal-700 dark:text-teal-400">
                    {(checkpoint.lastOnceLatestIds || []).length} / {windowSize}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--text-muted)]">Live Discord Posts</dt>
                  <dd className="mt-0.5 font-mono-tabular text-sm font-bold text-indigo-700 dark:text-indigo-400">
                    {activePosts.length} message(s)
                  </dd>
                </div>
              </dl>

              {/* Delete Sent Messages Action */}
              <div className="mt-4 border-t border-dashed border-[var(--border-subtle)] pt-4">
                {!confirmDeletePosts ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      disabled={activePosts.length === 0 || deletingPosts}
                      onClick={() => setConfirmDeletePosts(true)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-700 dark:border-rose-500/40 dark:text-rose-300 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer shadow-2xs"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Delete {activePosts.length || ''} Sent Discord Post(s)</span>
                    </button>
                    <span className="text-[11px] text-[var(--text-muted)]">
                      {activePosts.length === 0
                        ? 'No active Discord posts to delete'
                        : 'Wipes last forwarded batch from Discord'}
                    </span>
                  </div>
                ) : (
                  <div className="rounded-lg border border-rose-500/30 bg-rose-50/90 dark:bg-rose-500/10 p-3 text-xs">
                    <p className="font-semibold text-rose-900 dark:text-rose-200">
                      Delete {activePosts.length} forwarded message(s) from your Discord channel(s) right now?
                    </p>
                    <div className="mt-2.5 flex gap-2">
                      <button
                        type="button"
                        disabled={deletingPosts}
                        onClick={handleDeleteSentMessages}
                        className="rounded bg-rose-600 px-3 py-1.5 font-bold text-white hover:bg-rose-500 cursor-pointer"
                      >
                        {deletingPosts ? 'Deleting…' : 'Yes, Delete From Discord'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeletePosts(false)}
                        className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1.5 text-[var(--text-secondary)] cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {deleteFeedback && (
                  <p
                    className={`mt-2 text-xs font-semibold ${
                      deleteFeedback.tone === 'ok'
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : deleteFeedback.tone === 'warn'
                        ? 'text-amber-800 dark:text-amber-400'
                        : 'text-rose-700 dark:text-rose-400'
                    }`}
                  >
                    {deleteFeedback.text}
                  </p>
                )}
              </div>
            </section>
          </div>
        </div>

        {/* Bottom Activity & Cloud Log Stream Console */}
        <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-3.5">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-teal-600 dark:text-teal-400" />
              <h2 className="font-display text-base font-bold tracking-wider uppercase text-[var(--text-primary)]">
                Activity & Telemetry Log Stream
              </h2>
              <span className="rounded border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-0.5 font-mono-tabular text-xs text-[var(--text-muted)]">
                {filteredLogs.length} entries
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                placeholder="Filter logs by subject or ID…"
                className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2.5 py-1 font-mono-tabular text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-teal-500 focus:outline-none"
              />
              <div className="inline-flex rounded-md border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-0.5 text-xs">
                {['ALL', 'WARN', 'ERROR'].map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => setLogFilter(lvl)}
                    className={`rounded px-2.5 py-1 font-mono-tabular text-[11px] font-semibold transition cursor-pointer ${
                      logFilter === lvl
                        ? 'bg-teal-600 text-white dark:bg-teal-500 dark:text-slate-950 shadow-xs'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {lvl}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4 max-h-80 overflow-y-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)] divide-y divide-[var(--border-subtle)]">
            {filteredLogs.length === 0 ? (
              <div className="p-6 text-center text-xs text-[var(--text-muted)]">
                No matching log lines recorded yet. Trigger a run or send a channel ping to generate telemetry.
              </div>
            ) : (
              filteredLogs.map((entry) => (
                <div
                  key={entry.id}
                  className="grid grid-cols-1 gap-2 px-4 py-2.5 text-xs sm:grid-cols-[5.5rem_4.2rem_1fr] sm:items-baseline"
                >
                  <time className="font-mono-tabular text-[11px] text-[var(--text-muted)]">
                    {entry.timestamp || '—'}
                  </time>
                  <span>
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 font-mono-tabular text-[10px] font-bold ${
                        entry.level === 'ERROR'
                          ? 'bg-rose-500/15 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300'
                          : entry.level === 'WARN'
                          ? 'bg-amber-500/15 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300'
                          : 'bg-teal-500/10 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300'
                      }`}
                    >
                      {entry.level}
                    </span>
                  </span>
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium text-[var(--text-primary)] break-words">{entry.message}</p>
                    {entry.details && (
                      <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono-tabular text-[11px] text-[var(--text-secondary)]">
                        {Object.entries(entry.details).map(([k, v]) => (
                          <span key={k}>
                            <span className="text-[var(--text-muted)]">{k}=</span>
                            <span className="text-teal-700 dark:text-teal-300 font-semibold">
                              {typeof v === 'string' ? v : JSON.stringify(v)}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
