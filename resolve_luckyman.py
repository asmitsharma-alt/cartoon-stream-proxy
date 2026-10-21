#!/usr/bin/env python3
"""
Luckyman Link Resolver
======================
Extracts direct Cloudflare R2 download links for Luckyman Season 1 ZIP packs
from RareToons / RareAnimes.
"""

import re
import json
import urllib.request
import urllib.parse
from pathlib import Path

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

PAGE_URL = "https://www.rareanimes.mov/luckyman-1994-complete-all-episodes-hindi-dubbed-download-hd/"

def fetch_html(url, referer=None):
    headers = dict(HEADERS)
    if referer:
        headers['Referer'] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=25) as resp:
        return resp.read().decode('utf-8', errors='ignore')

def resolve_hubcloud_r2(gamerxyt_url):
    html = fetch_html(gamerxyt_url, referer="https://codedew.com/")
    matches = re.findall(r'href=[\'"](https://[a-f0-9]+\.r2\.cloudflarestorage\.com/[^\'"]+)[\'"]', html)
    if matches:
        return matches[0].replace('&amp;', '&')
    return None

def resolve_zipcloud(zipcloud_url):
    html = fetch_html(zipcloud_url, referer=PAGE_URL)
    # Look for gamerxyt url
    matches = re.findall(r"url\s*=\s*['\"](https://gamerxyt\.com/hubcloud\.php\?[^'\"]+)['\"]", html)
    if not matches:
        matches = re.findall(r'href=[\'"](https://gamerxyt\.com/hubcloud\.php\?[^\'"]+)[\'"]', html)
    if matches:
        return resolve_hubcloud_r2(matches[0])
    return None

def main():
    print(f"[*] Fetching page: {PAGE_URL}")
    page_html = fetch_html(PAGE_URL)

    # Find zipcloud links
    zipcloud_matches = re.findall(r'https://codedew\.com/zipcloud/\?[a-zA-Z0-9]+', page_html)
    unique_links = list(dict.fromkeys(zipcloud_matches))
    print(f"[+] Found {len(unique_links)} ZIP Cloud links:")
    for l in unique_links:
        print(f"    - {l}")

    packs = []
    for idx, zlink in enumerate(unique_links, start=1):
        print(f"[*] Resolving Pack {idx}: {zlink}")
        r2_url = resolve_zipcloud(zlink)
        if r2_url:
            print(f"[OK] Direct Cloudflare R2 link resolved for Pack {idx}!")
            packs.append({
                "part": idx,
                "name": f"Luckyman_S01_Part_{idx}",
                "title": f"Luckyman Season 1 EP {'1-25' if idx == 1 else '26-50'}",
                "show": "Luckyman",
                "season": "Season 01",
                "r2_url": r2_url,
                "source_page": zlink
            })
        else:
            print(f"[!] Failed to resolve direct link for {zlink}")

    out_file = Path(__file__).parent / "luckyman_packs.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(packs, f, indent=2)

    print(f"\n[OK] Saved {len(packs)} resolved packs to: {out_file}")

if __name__ == "__main__":
    main()
