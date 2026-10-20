# -*- coding: utf-8 -*-
"""
Google Colab Direct Google Drive Movie Remuxer
Folder: MyDrive/Doraemon_Movies_Hindi -> MyDrive/Doraemon_Movies_Remuxed
"""

import os
import glob
import shutil
import subprocess

print("==================================================================")
print("🎬 Google Colab: Doraemon Movies Remuxer (AAC + FastStart)")
print("📂 Source: MyDrive/Doraemon_Movies_Hindi")
print("🎯 Destination: MyDrive/Doraemon_Movies_Remuxed")
print("==================================================================")

# 1. Mount Google Drive
try:
    from google.colab import drive
    print("\n📁 Mounting Google Drive...")
    drive.mount('/content/drive')
except Exception as e:
    print("Drive mounting note:", e)

# Locate source directory
possible_dirs = [
    '/content/drive/MyDrive/Doraemon_Movies_Hindi',
    '/content/drive/MyDrive/doraemon_movies_hindi',
    '/content/drive/mydrive/Doraemon_Movies_Hindi',
    '/content/drive/Shareddrives/Doraemon_Movies_Hindi'
]

source_dir = None
for d in possible_dirs:
    if os.path.exists(d):
        source_dir = d
        break

if not source_dir:
    # Search for folder matching Doraemon_Movies_Hindi
    base = '/content/drive/MyDrive'
    if os.path.exists(base):
        for item in os.listdir(base):
            if 'doraemon' in item.lower() and 'movie' in item.lower():
                source_dir = os.path.join(base, item)
                break

if not source_dir:
    source_dir = '/content/drive/MyDrive/Doraemon_Movies_Hindi'
    print(f"⚠️ Warning: Could not find '{source_dir}'. Creating/checking path...")

output_dir = '/content/drive/MyDrive/Doraemon_Movies_Remuxed'
os.makedirs(output_dir, exist_ok=True)

# Find all video files
files = sorted(glob.glob(f"{source_dir}/*.mp4") + glob.glob(f"{source_dir}/*.mkv"))
print(f"\n🎬 Found {len(files)} movie files in {source_dir}\n")

if len(files) == 0:
    print("⚠️ No video files found in source directory! Please verify folder name in your Google Drive.")
    sys.exit(0)

temp_file = '/content/temp_remuxed.mp4'

for idx, fpath in enumerate(files):
    fname = os.path.basename(fpath)
    clean_name = fname.replace('.mkv', '.mp4')
    final_dest = os.path.join(output_dir, clean_name)

    if os.path.exists(final_dest) and os.path.getsize(final_dest) > 100 * 1024 * 1024:
        print(f"[{idx+1}/{len(files)}] ⏩ Already remuxed: {clean_name}")
        continue

    print(f"\n========================================================")
    print(f"[{idx+1}/{len(files)}] ⚙️ Remuxing: {fname}")
    print(f"========================================================")

    # 1. Try mapping Track 0:2 (Hindi dub on dual-audio releases)
    cmd = [
        'ffmpeg', '-y',
        '-i', fpath,
        '-map', '0:v:0',
        '-map', '0:2',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '48000',
        '-movflags', '+faststart',
        temp_file
    ]

    res = subprocess.run(cmd)

    if res.returncode != 0:
        # Fallback for single audio movies (where only 0:a:0 exists)
        print("  ℹ️ Single audio track detected, mapping primary track 0:a:0...")
        cmd_fallback = [
            'ffmpeg', '-y',
            '-i', fpath,
            '-map', '0:v:0',
            '-map', '0:a:0',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-ar', '48000',
            '-movflags', '+faststart',
            temp_file
        ]
        res = subprocess.run(cmd_fallback)

    if res.returncode == 0 and os.path.exists(temp_file):
        size_gb = os.path.getsize(temp_file) / (1024 * 1024 * 1024)
        print(f"  💾 Moving to Google Drive: {clean_name} ({size_gb:.2f} GB)...")
        shutil.move(temp_file, final_dest)
        print(f"  ✅ Completed successfully!")
    else:
        print(f"  ❌ Failed to remux {fname}")

    if os.path.exists(temp_file):
        os.remove(temp_file)

print("\n🎉 ALL MOVIES REMUXED AND SAVED TO MyDrive/Doraemon_Movies_Remuxed!")
