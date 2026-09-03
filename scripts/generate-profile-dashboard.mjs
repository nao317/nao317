import { mkdir, writeFile } from "node:fs/promises";

const username = process.env.GITHUB_USERNAME || "nao317";
const token = process.env.GITHUB_TOKEN;
const apiBase = "https://api.github.com";
const assetsDirectory = new URL("../assets/", import.meta.url);
const maxRateLimitRetries = 3;

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": `${username}-profile-dashboard`,
  "X-GitHub-Api-Version": "2022-11-28",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

const themes = {
  light: {
    background: "#f6f7f4",
    surface: "#ffffff",
    subtle: "#eef1ec",
    border: "#d8ddd7",
    grid: "#e7eae6",
    text: "#171b18",
    muted: "#66706a",
    accent: "#167d4d",
    blue: "#2774d7",
    amber: "#c47a13",
    coral: "#d15142",
  },
  dark: {
    background: "#131613",
    surface: "#1a1e1b",
    subtle: "#222823",
    border: "#343b35",
    grid: "#2b312c",
    text: "#f1f4ef",
    muted: "#a7b0a9",
    accent: "#4fc184",
    blue: "#6da8f3",
    amber: "#e8a849",
    coral: "#ed7668",
  },
};

const languageColors = [
  "#2da66b",
  "#4285df",
  "#d9912d",
  "#df6354",
  "#856bd1",
  "#35a0aa",
  "#a28255",
  "#8e9891",
];

function rateLimitDelay(response, retry) {
  const retryAfterHeader = response.headers.get("retry-after");
  if (retryAfterHeader !== null) {
    const retryAfter = Number(retryAfterHeader);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
      return retryAfter * 1000;
    }
  }

  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const resetHeader = response.headers.get("x-ratelimit-reset");
    if (resetHeader !== null) {
      const reset = Number(resetHeader);
      if (Number.isFinite(reset)) {
        return Math.max(reset * 1000 - Date.now(), 0) + 1000;
      }
    }
  }

  return 60_000 * 2 ** retry;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function github(path) {
  for (let retry = 0; ; retry += 1) {
    const response = await fetch(`${apiBase}${path}`, { headers });
    if (response.ok) return response.json();

    const body = await response.text();
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          /rate limit/i.test(body)));

    if (!rateLimited || retry >= maxRateLimitRetries) {
      throw new Error(`GitHub API ${response.status} for ${path}: ${body}`);
    }

    const delay = rateLimitDelay(response, retry);
    console.warn(
      `GitHub API rate limit for ${path}; retrying in ${Math.ceil(delay / 1000)} seconds (${retry + 1}/${maxRateLimitRetries}).`,
    );
    await sleep(delay);
  }
}

async function searchCommits() {
  const query = encodeURIComponent(`author:${username}`);
  const items = [];
  let totalCount = 0;

  for (let page = 1; page <= 10; page += 1) {
    const result = await github(
      `/search/commits?q=${query}&sort=author-date&order=desc&per_page=100&page=${page}`,
    );
    totalCount = result.total_count;
    items.push(...result.items);
    if (result.items.length < 100 || items.length >= Math.min(totalCount, 1000)) break;
  }

  if (totalCount > 1000) {
    throw new Error("Commit history exceeds GitHub Search's 1,000-result limit.");
  }
  return items;
}

function monthKey(date) {
  return date.toISOString().slice(0, 7);
}

function monthRange(start, end) {
  const months = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor <= last) {
    months.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function commitsSince(dates, now, days) {
  const boundary = new Date(now);
  boundary.setUTCDate(boundary.getUTCDate() - days);
  return dates.filter((date) => date >= boundary).length;
}

function summarizeLanguages(languageBytes) {
  const total = Object.values(languageBytes).reduce((sum, bytes) => sum + bytes, 0);
  if (!total) return [];
  const sorted = Object.entries(languageBytes).sort((a, b) => b[1] - a[1]);
  const visible = sorted.slice(0, 7).map(([name, bytes]) => ({
    name,
    percentage: (bytes / total) * 100,
  }));
  const other = sorted.slice(7).reduce((sum, [, bytes]) => sum + bytes, 0);
  if (other) visible.push({ name: "Other", percentage: (other / total) * 100 });
  return visible;
}

async function collectData() {
  const searchResults = await searchCommits();
  const profileRepo = `${username}/${username}`.toLowerCase();
  const uniqueCommits = new Map();

  for (const item of searchResults) {
    if (item.repository.full_name.toLowerCase() === profileRepo) continue;
    if (item.repository.fork) continue;
    uniqueCommits.set(`${item.repository.full_name}:${item.sha}`, item);
  }

  const commits = [...uniqueCommits.values()];
  const repositories = [
    ...new Map(commits.map((item) => [item.repository.full_name, item.repository])).values(),
  ];
  const languageResults = [];
  for (const repo of repositories) {
    languageResults.push(await github(`/repos/${repo.full_name}/languages`));
  }
  const languageBytes = {};
  for (const languages of languageResults) {
    for (const [language, bytes] of Object.entries(languages)) {
      languageBytes[language] = (languageBytes[language] || 0) + bytes;
    }
  }

  const dates = commits
    .map((item) => item.commit?.author?.date || item.commit?.committer?.date)
    .filter(Boolean)
    .map((value) => new Date(value))
    .sort((a, b) => a - b);
  const now = new Date();
  const firstCommit = dates.at(0) || now;
  const monthlyCounts = Object.fromEntries(
    monthRange(firstCommit, now).map((month) => [month, 0]),
  );
  for (const date of dates) monthlyCounts[monthKey(date)] += 1;

  const activeBoundary = new Date(now);
  activeBoundary.setUTCDate(activeBoundary.getUTCDate() - 90);
  const activeRepositories = new Set(
    commits
      .filter((item) => new Date(item.commit?.author?.date) >= activeBoundary)
      .map((item) => item.repository.full_name),
  ).size;

  return {
    generatedAt: now,
    commits: dates.length,
    repositories: repositories.length,
    activeRepositories,
    firstYear: firstCommit.getUTCFullYear(),
    recent: [
      { label: "30 days", days: 30, commits: commitsSince(dates, now, 30) },
      { label: "90 days", days: 90, commits: commitsSince(dates, now, 90) },
      { label: "365 days", days: 365, commits: commitsSince(dates, now, 365) },
    ],
    monthly: Object.entries(monthlyCounts).map(([month, count]) => ({ month, count })),
    languages: summarizeLanguages(languageBytes),
  };
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function number(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function svgShell({ width, height, colors, content }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Nao Okumura development history</title>
  <desc id="desc">Dashboard of public commits, monthly activity, active repositories, and source language distribution.</desc>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0; }
    .title { fill: ${colors.text}; font-size: 28px; font-weight: 750; }
    .heading { fill: ${colors.text}; font-size: 17px; font-weight: 700; }
    .label { fill: ${colors.muted}; font-size: 11px; font-weight: 600; }
    .eyebrow { fill: ${colors.accent}; font-size: 10px; font-weight: 750; }
    .value { fill: ${colors.text}; font-size: 29px; font-weight: 760; }
    .small { fill: ${colors.muted}; font-size: 10px; }
    .axis { fill: ${colors.muted}; font-size: 9px; }
  </style>
  <rect width="${width}" height="${height}" rx="8" fill="${colors.background}"/>
  ${content}
</svg>`;
}

function panel(colors, x, y, width, height) {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" fill="${colors.surface}" stroke="${colors.border}"/>`;
}

function renderHeader(data, colors, width, mobile = false) {
  const x = mobile ? 18 : 26;
  const date = data.generatedAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `
    <text x="${x}" y="${mobile ? 31 : 34}" class="eyebrow">PUBLIC GITHUB ACTIVITY</text>
    <text x="${x}" y="${mobile ? 62 : 67}" class="title">Development History</text>
    <text x="${width - x}" y="${mobile ? 84 : 62}" text-anchor="end" class="small">Updated ${xml(date)}</text>`;
}

function renderMetrics(data, colors, layout) {
  const metrics = [
    ["PUBLIC COMMITS", number(data.commits), "authored commits"],
    ["REPOSITORIES", number(data.repositories), "with contributions"],
    ["ACTIVE PROJECTS", number(data.activeRepositories), "last 90 days"],
    ["HISTORY SINCE", data.firstYear, "first public commit"],
  ];
  return metrics
    .map(([label, value, note], index) => {
      const column = index % layout.columns;
      const row = Math.floor(index / layout.columns);
      const x = layout.x + column * (layout.width + layout.gap);
      const y = layout.y + row * (layout.height + layout.gap);
      return `${panel(colors, x, y, layout.width, layout.height)}
        <text x="${x + 16}" y="${y + 23}" class="eyebrow">${label}</text>
        <text x="${x + 16}" y="${y + 58}" class="value">${value}</text>
        <text x="${x + 16}" y="${y + 76}" class="small">${note}</text>`;
    })
    .join("");
}

function renderTimeline(data, colors, box, monthCount) {
  const months = data.monthly.slice(-monthCount);
  const padding = { left: 38, right: 16, top: 58, bottom: 35 };
  const chartX = box.x + padding.left;
  const chartY = box.y + padding.top;
  const chartWidth = box.width - padding.left - padding.right;
  const chartHeight = box.height - padding.top - padding.bottom;
  const maxCount = Math.max(...months.map((item) => item.count), 1);
  const gridMax = Math.max(5, Math.ceil(maxCount / 5) * 5);
  const step = chartWidth / Math.max(months.length, 1);
  const barWidth = Math.max(4, Math.min(24, step * 0.62));
  let content = `${panel(colors, box.x, box.y, box.width, box.height)}
    <text x="${box.x + 18}" y="${box.y + 24}" class="eyebrow">COMMIT TIMELINE</text>
    <text x="${box.x + 18}" y="${box.y + 46}" class="heading">Activity over time</text>`;

  for (let index = 0; index <= 3; index += 1) {
    const y = chartY + (chartHeight / 3) * index;
    const value = Math.round(gridMax - (gridMax / 3) * index);
    content += `<line x1="${chartX}" y1="${y}" x2="${chartX + chartWidth}" y2="${y}" stroke="${colors.grid}"/>
      <text x="${chartX - 7}" y="${y + 3}" text-anchor="end" class="axis">${value}</text>`;
  }

  months.forEach((item, index) => {
    const height = (item.count / gridMax) * chartHeight;
    const x = chartX + index * step + (step - barWidth) / 2;
    const y = chartY + chartHeight - height;
    content += `<g><title>${xml(item.month)}: ${item.count} commits</title><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(height, item.count ? 2 : 0).toFixed(1)}" rx="2" fill="${colors.accent}"/></g>`;
    const labelEvery = months.length > 14 ? 3 : 2;
    if (index % labelEvery === 0 || index === months.length - 1) {
      content += `<text x="${(chartX + index * step + step / 2).toFixed(1)}" y="${box.y + box.height - 13}" text-anchor="middle" class="axis">${xml(item.month.slice(2).replace("-", "."))}</text>`;
    }
  });
  return content;
}

function renderLanguages(data, colors, box, mobile = false) {
  const centerX = box.x + (mobile ? 104 : 86);
  const centerY = box.y + (mobile ? 112 : 123);
  const radius = mobile ? 48 : 54;
  const stroke = mobile ? 18 : 20;
  const circumference = 2 * Math.PI * radius;
  const legendX = box.x + (mobile ? 178 : 158);
  let offset = 0;
  let content = `${panel(colors, box.x, box.y, box.width, box.height)}
    <text x="${box.x + 18}" y="${box.y + 24}" class="eyebrow">SOURCE FOOTPRINT</text>
    <text x="${box.x + 18}" y="${box.y + 47}" class="heading">Language distribution</text>
    <circle cx="${centerX}" cy="${centerY}" r="${radius}" fill="none" stroke="${colors.subtle}" stroke-width="${stroke}"/>`;

  data.languages.forEach((language, index) => {
    const length = (language.percentage / 100) * circumference;
    const color = languageColors[index % languageColors.length];
    const legendY = box.y + 77 + index * (mobile ? 18 : 20);
    content += `<circle cx="${centerX}" cy="${centerY}" r="${radius}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${centerX} ${centerY})"><title>${xml(language.name)}: ${language.percentage.toFixed(1)}%</title></circle>
      <rect x="${legendX}" y="${legendY - 8}" width="8" height="8" rx="2" fill="${color}"/>
      <text x="${legendX + 14}" y="${legendY}" class="label">${xml(language.name)}</text>
      <text x="${box.x + box.width - 16}" y="${legendY}" text-anchor="end" class="label">${language.percentage.toFixed(1)}%</text>`;
    offset += length;
  });
  content += `<text x="${centerX}" y="${centerY + 3}" text-anchor="middle" class="value">${data.languages.length}</text>
    <text x="${centerX}" y="${centerY + 19}" text-anchor="middle" class="small">languages</text>`;
  return content;
}

function renderMomentum(data, colors, box, mobile = false) {
  const rates = data.recent.map((item) => item.commits / item.days);
  const maxRate = Math.max(...rates, 1);
  let content = `${panel(colors, box.x, box.y, box.width, box.height)}
    <text x="${box.x + 18}" y="${box.y + 24}" class="eyebrow">RECENT PACE</text>
    <text x="${box.x + 18}" y="${box.y + 47}" class="heading">Commit momentum</text>`;
  data.recent.forEach((item, index) => {
    const rowY = box.y + 76 + index * (mobile ? 40 : 42);
    const barWidth = box.width - 36;
    const fillWidth = (rates[index] / maxRate) * barWidth;
    const color = [colors.blue, colors.amber, colors.coral][index];
    content += `<text x="${box.x + 18}" y="${rowY}" class="label">Last ${item.label}</text>
      <text x="${box.x + box.width - 18}" y="${rowY}" text-anchor="end" class="label">${number(item.commits)}</text>
      <rect x="${box.x + 18}" y="${rowY + 9}" width="${barWidth}" height="7" rx="3.5" fill="${colors.subtle}"/>
      <rect x="${box.x + 18}" y="${rowY + 9}" width="${fillWidth.toFixed(1)}" height="7" rx="3.5" fill="${color}"/>`;
  });
  return content;
}

function renderDesktop(data, colors) {
  const width = 900;
  const height = 680;
  const content = [
    renderHeader(data, colors, width),
    renderMetrics(data, colors, { x: 24, y: 88, width: 204, height: 84, gap: 12, columns: 4 }),
    renderTimeline(data, colors, { x: 24, y: 190, width: 548, height: 276 }, 18),
    renderLanguages(data, colors, { x: 584, y: 190, width: 292, height: 276 }),
    renderMomentum(data, colors, { x: 24, y: 478, width: 852, height: 178 }),
  ].join("");
  return svgShell({ width, height, colors, content });
}

function renderMobile(data, colors) {
  const width = 420;
  const height = 1000;
  const content = [
    renderHeader(data, colors, width, true),
    renderMetrics(data, colors, { x: 16, y: 100, width: 188, height: 84, gap: 12, columns: 2 }),
    renderTimeline(data, colors, { x: 16, y: 296, width: 388, height: 260 }, 12),
    renderLanguages(data, colors, { x: 16, y: 568, width: 388, height: 224 }, true),
    renderMomentum(data, colors, { x: 16, y: 804, width: 388, height: 180 }, true),
  ].join("");
  return svgShell({ width, height, colors, content });
}

async function generate() {
  const data = await collectData();
  await mkdir(assetsDirectory, { recursive: true });
  const outputs = [
    ["development-dashboard.svg", renderDesktop(data, themes.light)],
    ["development-dashboard-dark.svg", renderDesktop(data, themes.dark)],
    ["development-dashboard-mobile.svg", renderMobile(data, themes.light)],
    ["development-dashboard-mobile-dark.svg", renderMobile(data, themes.dark)],
  ];
  await Promise.all(
    outputs.map(([name, svg]) => writeFile(new URL(name, assetsDirectory), `${svg}\n`)),
  );
  console.log(`Generated profile dashboard from ${data.commits} public commits.`);
}

generate().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
