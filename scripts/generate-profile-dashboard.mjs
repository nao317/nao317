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
    background: "#fafaf8",
    subtle: "#e8eae6",
    border: "#d5d8d2",
    grid: "#e2e4e0",
    text: "#1b1d1b",
    muted: "#6b706b",
    accent: "#3f735c",
    series: ["#3f735c", "#66796e", "#7c8981", "#929b95", "#a5aba7", "#b6bbb7", "#c6cac7", "#d5d7d5"],
  },
  dark: {
    background: "#171917",
    subtle: "#2b2f2c",
    border: "#393d39",
    grid: "#303430",
    text: "#f0f1ee",
    muted: "#9da29d",
    accent: "#82ad97",
    series: ["#82ad97", "#81958a", "#7d8982", "#747d77", "#69706c", "#5d625f", "#505451", "#424542"],
  },
};

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
    .title { fill: ${colors.text}; font-size: 24px; font-weight: 650; }
    .heading { fill: ${colors.text}; font-size: 14px; font-weight: 650; }
    .label { fill: ${colors.muted}; font-size: 11px; font-weight: 500; }
    .value { fill: ${colors.text}; font-size: 29px; font-weight: 650; }
    .small { fill: ${colors.muted}; font-size: 10px; }
    .axis { fill: ${colors.muted}; font-size: 9px; }
  </style>
  <rect width="${width}" height="${height}" rx="4" fill="${colors.background}"/>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="3.5" fill="none" stroke="${colors.border}"/>
  ${content}
</svg>`;
}

function renderHeader(data, colors, width, mobile = false) {
  const x = mobile ? 18 : 28;
  const date = data.generatedAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `
    <text x="${x}" y="${mobile ? 38 : 39}" class="title">Development history</text>
    <text x="${x}" y="${mobile ? 64 : 59}" class="small">github.com/${xml(username)}</text>
    <text x="${width - x}" y="${mobile ? 64 : 39}" text-anchor="end" class="small">Updated ${xml(date)}</text>
    <line x1="${x}" y1="${mobile ? 82 : 72}" x2="${width - x}" y2="${mobile ? 82 : 72}" stroke="${colors.border}"/>`;
}

function renderMetrics(data, colors, layout) {
  const metrics = [
    ["Public commits", number(data.commits), "authored commits"],
    ["Repositories", number(data.repositories), "with contributions"],
    ["Active projects", number(data.activeRepositories), "in the last 90 days"],
    ["History since", data.firstYear, "first public commit"],
  ];
  const cellWidth = layout.width / layout.columns;
  return metrics
    .map(([label, value, note], index) => {
      const column = index % layout.columns;
      const row = Math.floor(index / layout.columns);
      const x = layout.x + column * cellWidth;
      const y = layout.y + row * layout.rowHeight;
      const inset = column === 0 ? 0 : 16;
      const divider = column
        ? `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + 62}" stroke="${colors.border}"/>`
        : "";
      const rowDivider = column === 0 && row > 0
        ? `<line x1="${layout.x}" y1="${y - 11}" x2="${layout.x + layout.width}" y2="${y - 11}" stroke="${colors.border}"/>`
        : "";
      return `${divider}${rowDivider}
        <text x="${x + inset}" y="${y + 11}" class="label">${label}</text>
        <text x="${x + inset}" y="${y + 43}" class="value">${value}</text>
        <text x="${x + inset}" y="${y + 61}" class="small">${note}</text>`;
    })
    .join("");
}

function renderTimeline(data, colors, box, monthCount) {
  const months = data.monthly.slice(-monthCount);
  const padding = { left: 34, right: 8, top: 38, bottom: 27 };
  const chartX = box.x + padding.left;
  const chartY = box.y + padding.top;
  const chartWidth = box.width - padding.left - padding.right;
  const chartHeight = box.height - padding.top - padding.bottom;
  const maxCount = Math.max(...months.map((item) => item.count), 1);
  const gridMax = Math.max(5, Math.ceil(maxCount / 5) * 5);
  const step = chartWidth / Math.max(months.length, 1);
  const barWidth = Math.max(4, Math.min(24, step * 0.62));
  let content = `<text x="${box.x}" y="${box.y + 14}" class="heading">Monthly commits</text>`;

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
    content += `<g><title>${xml(item.month)}: ${item.count} commits</title><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(height, item.count ? 2 : 0).toFixed(1)}" rx="1" fill="${colors.accent}"/></g>`;
    const labelEvery = months.length > 14 ? 3 : 2;
    const nextLabelIsLast = index === months.length - 2;
    if ((index % labelEvery === 0 && !nextLabelIsLast) || index === months.length - 1) {
      content += `<text x="${(chartX + index * step + step / 2).toFixed(1)}" y="${box.y + box.height - 13}" text-anchor="middle" class="axis">${xml(item.month.slice(2).replace("-", "."))}</text>`;
    }
  });
  return content;
}

function renderLanguages(data, colors, box, mobile = false) {
  const rowGap = mobile ? 24 : 25;
  const barWidth = box.width;
  let content = `<text x="${box.x}" y="${box.y + 14}" class="heading">Languages by source size</text>`;

  data.languages.forEach((language, index) => {
    const y = box.y + 39 + index * rowGap;
    const fillWidth = (language.percentage / 100) * barWidth;
    const color = colors.series[index % colors.series.length];
    content += `<text x="${box.x}" y="${y}" class="label">${xml(language.name)}</text>
      <text x="${box.x + box.width}" y="${y}" text-anchor="end" class="label">${language.percentage.toFixed(1)}%</text>
      <rect x="${box.x}" y="${y + 7}" width="${barWidth}" height="3" fill="${colors.subtle}"/>
      <rect x="${box.x}" y="${y + 7}" width="${fillWidth.toFixed(1)}" height="3" fill="${color}"/>`;
  });
  return content;
}

function renderMomentum(data, colors, box, mobile = false) {
  const rates = data.recent.map((item) => item.commits / item.days);
  const maxRate = Math.max(...rates, 1);
  let content = `<text x="${box.x}" y="${box.y + 14}" class="heading">Recent commit pace</text>`;
  data.recent.forEach((item, index) => {
    const columnWidth = box.width / 3;
    const x = mobile ? box.x : box.x + index * columnWidth;
    const rowY = mobile ? box.y + 43 + index * 51 : box.y + 43;
    const barWidth = mobile ? box.width : columnWidth - 28;
    const fillWidth = (rates[index] / maxRate) * barWidth;
    const valueX = mobile ? box.x + box.width : x;
    const valueAnchor = mobile ? "end" : "start";
    const divider = !mobile && index
      ? `<line x1="${x - 14}" y1="${box.y + 32}" x2="${x - 14}" y2="${box.y + 86}" stroke="${colors.border}"/>`
      : "";
    content += `${divider}<text x="${x}" y="${rowY}" class="label">Last ${item.label}</text>
      <text x="${valueX}" y="${rowY + 25}" text-anchor="${valueAnchor}" class="heading">${number(item.commits)} commits</text>
      <rect x="${x}" y="${rowY + 36}" width="${barWidth}" height="3" fill="${colors.subtle}"/>
      <rect x="${x}" y="${rowY + 36}" width="${fillWidth.toFixed(1)}" height="3" fill="${colors.accent}"/>`;
  });
  return content;
}

function renderDesktop(data, colors) {
  const width = 900;
  const height = 600;
  const content = [
    renderHeader(data, colors, width),
    renderMetrics(data, colors, { x: 28, y: 91, width: 844, rowHeight: 74, columns: 4 }),
    `<line x1="28" y1="172" x2="872" y2="172" stroke="${colors.border}"/>`,
    renderTimeline(data, colors, { x: 28, y: 194, width: 548, height: 240 }, 18),
    `<line x1="600" y1="194" x2="600" y2="434" stroke="${colors.border}"/>`,
    renderLanguages(data, colors, { x: 624, y: 194, width: 248, height: 240 }),
    `<line x1="28" y1="456" x2="872" y2="456" stroke="${colors.border}"/>`,
    renderMomentum(data, colors, { x: 28, y: 474, width: 844, height: 98 }),
  ].join("");
  return svgShell({ width, height, colors, content });
}

function renderMobile(data, colors) {
  const width = 420;
  const height = 1000;
  const content = [
    renderHeader(data, colors, width, true),
    renderMetrics(data, colors, { x: 18, y: 104, width: 384, rowHeight: 84, columns: 2 }),
    `<line x1="18" y1="268" x2="402" y2="268" stroke="${colors.border}"/>`,
    renderTimeline(data, colors, { x: 18, y: 288, width: 384, height: 226 }, 12),
    `<line x1="18" y1="530" x2="402" y2="530" stroke="${colors.border}"/>`,
    renderLanguages(data, colors, { x: 18, y: 550, width: 384, height: 212 }, true),
    `<line x1="18" y1="780" x2="402" y2="780" stroke="${colors.border}"/>`,
    renderMomentum(data, colors, { x: 18, y: 800, width: 384, height: 180 }, true),
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
