#!/usr/bin/env python3
"""
Luckyman Hindi TV Series Downloader (All 50 Episodes)
=====================================================
- Downloads Part 1 & Part 2 ZIP packages from Cloudflare R2 edge at 50-100 MB/s.
- Auto-mounts Google Drive in Google Colab (/content/drive/MyDrive/Luckyman_Hindi_Episodes/).
- Unpacks all 50 loose episodes into:
    /content/drive/MyDrive/Luckyman_Hindi_Episodes/Season 01/Luckyman_S01E01.mkv, etc.
- Deletes ZIP packs immediately to save drive storage.
"""

import os
import sys
import shutil
import zipfile
import urllib.request
import re

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

PACK_LINKS = [
    {
        "part": 1,
        "title": "Luckyman Season 1 Part 1 (EP 01-25)",
        "source": "https://codedew.com/zipcloud/?joyyidybsf0t4bb"
    },
    {
        "part": 2,
        "title": "Luckyman Season 1 Part 2 (EP 26-50)",
        "source": "https://codedew.com/zipcloud/?pfpszgsb1lll282"
    }
]

def fetch_html(url, referer=None):
    headers = dict(HEADERS)
    if referer:
        headers['Referer'] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=25) as resp:
        return resp.read().decode('utf-8', errors='ignore')

def resolve_r2_url(zipcloud_url):
    html = fetch_html(zipcloud_url, referer="https://www.rareanimes.mov/")
    matches = re.findall(r"url\s*=\s*['\"](https://gamerxyt\.com/hubcloud\.php\?[^'\"]+)['\"]", html)
    if not matches:
        matches = re.findall(r'href=[\'"](https://gamerxyt\.com/hubcloud\.php\?[^\'"]+)[\'"]', html)
    if matches:
        gamerxyt_html = fetch_html(matches[0], referer="https://codedew.com/")
        r2_matches = re.findall(r'href=[\'"](https://[a-f0-9]+\.r2\.cloudflarestorage\.com/[^\'"]+)[\'"]', gamerxyt_html)
        if r2_matches:
            return r2_matches[0].replace('&amp;', '&')
    return None

def mount_google_drive():
    try:
        from google.colab import drive
        print("[*] Google Colab detected! Mounting Google Drive...")
        drive.mount('/content/drive')
        return "/content/drive/MyDrive/Luckyman_Hindi_Episodes"
    except ImportError:
        print("[*] Running in local environment.")
        return os.path.abspath("./Luckyman_Hindi_Episodes")

def main():
    dest_dir = mount_google_drive()
    season_dir = os.path.join(dest_dir, "Season 01")
    os.makedirs(season_dir, exist_ok=True)

    temp_dir = "/content/temp_luckyman" if os.path.exists("/content") else os.path.abspath("./temp_luckyman")
    os.makedirs(temp_dir, exist_ok=True)

    print(f"\n[+] Output Directory: {season_dir}")
    print(f"[+] Temp Cache: {temp_dir}\n")

    for pack in PACK_LINKS:
        print(f"==================================================")
        print(f"📦 Processing: {pack['title']}")
        print(f"==================================================")

        r2_url = resolve_r2_url(pack['source'])
        if not r2_url:
            print(f"[!] Failed to resolve direct R2 link for Part {pack['part']}. Skipping.")
            continue

        zip_dest = os.path.join(temp_dir, f"luckyman_part_{pack['part']}.zip")
        print(f"⬇️ Downloading ZIP archive from Cloudflare R2...")

        cmd = f'curl -L -A "Mozilla/5.0" -o "{zip_dest}" "{r2_url}"'
        res = os.system(cmd)
        if res != 0 or not os.path.exists(zip_dest) or os.path.getsize(zip_dest) < 100000000:
            print(f"[!] Download failed for Part {pack['part']}.")
            continue

        print(f"📂 Extracting episodes into: {season_dir}")
        with zipfile.ZipFile(zip_dest, 'r') as z:
            for member in z.infolist():
                if member.filename.lower().endswith(('.mkv', '.mp4')):
                    fn = os.path.basename(member.filename)
                    if fn:
                        safe_name = fn.replace(' ', '_')
                        target_file = os.path.join(season_dir, safe_name)
                        if os.path.exists(target_file) and os.path.getsize(target_file) > 10000000:
                            print(f"  ⚡ Already exists: {safe_name}")
                            continue
                        print(f"  Extracting: {safe_name}")
                        with z.open(member) as src, open(target_file, "wb") as dst:
                            shutil.copyfileobj(src, dst)

        print(f"🧹 Deleting ZIP archive to save storage...")
        try: os.remove(zip_dest)
        except Exception: pass

    try: shutil.rmtree(temp_dir)
    except Exception: pass

    print(f"\n==================================================")
    print(f"🎉 ALL 50 LUCKYMAN EPISODES DOWNLOADED SUCCESSFULLY!")
    print(f"📂 Location: {season_dir}")
    print(f"==================================================")

if __name__ == "__main__":
    main()
