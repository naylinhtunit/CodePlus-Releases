const DOWNLOAD_ASSETS = {
  macos: 'CodePlus-macOS-arm64.dmg',
  windows: 'CodePlus-windows-x64-setup.exe'
};

function platformForAsset(assetName) {
  const name = String(assetName || '').toLowerCase();
  if (name === DOWNLOAD_ASSETS.macos.toLowerCase() || (name.includes('codeplus') && name.endsWith('.dmg') && /(macos|aarch64|arm64)/.test(name))) return 'macos';
  if (name === DOWNLOAD_ASSETS.windows.toLowerCase() || (name.includes('codeplus') && name.endsWith('.exe') && /(windows|win32|x64|setup)/.test(name))) return 'windows';
  return '';
}

export default async function handler(request, response) {
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed.' });
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'CodePlus-download-counter'
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  try {
    const githubResponse = await fetch('https://api.github.com/repos/naylinhtunit/CodePlus-Releases/releases?per_page=100', { headers });
    if (!githubResponse.ok) return response.status(githubResponse.status).json({ error: 'Could not read GitHub releases.', counts: { macos: null, windows: null } });
    const releases = (await githubResponse.json()).filter(release => !release.draft);
    const counts = { macos: 0, windows: 0 };
    const urls = {};
    const found = { macos: false, windows: false };
    for (const release of releases) {
      for (const asset of release.assets || []) {
        const platform = platformForAsset(asset.name);
        if (!platform) continue;
        found[platform] = true;
        counts[platform] += Number(asset.download_count) || 0;
        if (!urls[platform] && asset.browser_download_url) urls[platform] = asset.browser_download_url;
      }
    }
    for (const platform of Object.keys(counts)) if (!found[platform]) counts[platform] = null;
    response.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    return response.status(200).json({ counts, urls });
  } catch (error) {
    return response.status(502).json({ error: error.message || 'Could not read GitHub releases.', counts: { macos: null, windows: null } });
  }
}
