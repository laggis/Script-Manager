'use strict';

const { execFile } = require('child_process');

const previousWindowsSamples = new Map();

/**
 * Collect CPU and memory usage for a set of processes.
 *
 * On Windows we intentionally avoid WMIC/WMI. The old implementation asked
 * pidusage to inspect every PID separately, which created many WMIC processes
 * and could keep WMI Provider Host busy. One hidden PowerShell process now uses
 * the native .NET Process API to read all managed PIDs in a single batch.
 *
 * Returned CPU values use the same familiar "100% per fully used CPU core"
 * scale used by most process monitors. A process fully using two cores can therefore report
 * approximately 200%.
 */
async function getProcessStats(pids) {
  const uniquePids = [...new Set(
    (Array.isArray(pids) ? pids : [pids])
      .map(Number)
      .filter(pid => Number.isInteger(pid) && pid > 0)
  )];

  if (uniquePids.length === 0) return {};

  if (process.platform === 'win32') {
    return collectWindowsStats(uniquePids);
  }

  return collectUnixStats(uniquePids);
}

function collectWindowsStats(pids) {
  return new Promise((resolve, reject) => {
    const idList = pids.join(',');
    const command = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$ids = @(${idList})`,
      '$items = foreach ($id in $ids) {',
      '  try {',
      '    $p = Get-Process -Id $id -ErrorAction Stop',
      '    $cpuSeconds = 0',
      '    if ($null -ne $p.CPU) { $cpuSeconds = [double]$p.CPU }',
      '    [PSCustomObject]@{',
      '      id = [int]$p.Id',
      '      cpuSeconds = $cpuSeconds',
      '      memory = [int64]$p.WorkingSet64',
      '    }',
      '  } catch {}',
      '}',
      'ConvertTo-Json -InputObject @($items) -Compress',
    ].join('\n');

    execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command', command,
      ],
      {
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message || error).trim();
          reject(new Error(`Unable to collect process statistics: ${detail}`));
          return;
        }

        try {
          const text = String(stdout || '').trim();
          const rows = text ? JSON.parse(text) : [];
          const list = Array.isArray(rows) ? rows : [rows];
          const now = Date.now();
          const active = new Set();
          const output = {};

          for (const row of list) {
            const pid = Number(row.id);
            const cpuSeconds = Number(row.cpuSeconds) || 0;
            const memory = Math.max(0, Number(row.memory) || 0);
            if (!Number.isInteger(pid) || pid <= 0) continue;

            active.add(pid);
            const previous = previousWindowsSamples.get(pid);
            let cpu = 0;

            if (previous) {
              const elapsedSeconds = (now - previous.timestamp) / 1000;
              const usedCpuSeconds = cpuSeconds - previous.cpuSeconds;
              if (elapsedSeconds > 0 && usedCpuSeconds >= 0) {
                cpu = (usedCpuSeconds / elapsedSeconds) * 100;
              }
            }

            // Guard against impossible readings caused by PID reuse or a
            // transient process-query issue.
            if (!Number.isFinite(cpu) || cpu < 0) cpu = 0;

            output[pid] = {
              cpu,
              memory,
              elapsed: previous ? now - previous.timestamp : 0,
              timestamp: now,
            };

            previousWindowsSamples.set(pid, { cpuSeconds, timestamp: now });
          }

          // Remove samples for processes that are no longer being monitored so
          // a recycled PID cannot inherit an old CPU baseline.
          for (const pid of previousWindowsSamples.keys()) {
            if (!pids.includes(pid) || !active.has(pid)) {
              previousWindowsSamples.delete(pid);
            }
          }

          resolve(output);
        } catch (parseError) {
          reject(new Error(`Invalid process statistics response: ${parseError.message}`));
        }
      }
    );
  });
}


function collectUnixStats(pids) {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-o', 'pid=,pcpu=,rss=', '-p', pids.join(',')],
      { timeout: 8000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        // ps may return a non-zero code when every requested process exits
        // between collection and execution. Treat an empty result as normal.
        if (error && !String(stdout || '').trim()) {
          const detail = String(stderr || error.message || error).trim();
          reject(new Error(`Unable to collect process statistics: ${detail}`));
          return;
        }

        const output = {};
        for (const line of String(stdout || '').split(/\r?\n/)) {
          const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)$/);
          if (!match) continue;

          const pid = Number(match[1]);
          output[pid] = {
            cpu: Number(match[2]) || 0,
            memory: (Number(match[3]) || 0) * 1024,
            timestamp: Date.now(),
          };
        }
        resolve(output);
      }
    );
  });
}

function clearProcessStats() {
  previousWindowsSamples.clear();
}

module.exports = {
  getProcessStats,
  clearProcessStats,
};
