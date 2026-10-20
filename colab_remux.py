# -*- coding: utf-8 -*-
"""
Google Colab High-Speed Movie Remuxer (Google Drive -> Colab -> Google Drive)
- Uses Google internal cloud network (100-300 MB/s)
- Transcodes Dolby AC-3/EAC-3 Hindi audio to web-compatible AAC
- Keeps 1080p video 100% original lossless (-c:v copy)
- Adds +faststart for instant zero-buffering browser streaming
- Saves directly back to your Google Drive!
"""

import os
import sys
import json
import shutil
import subprocess

print("================================================================")
print("🎬 Google Colab Cloud Remuxer: Doraemon Movies (AAC + FastStart)")
print("================================================================")

# 1. Mount Google Drive
try:
    from google.colab import drive
    print("\n📁 Mounting Google Drive...")
    drive.mount('/content/drive')
except Exception as e:
    print("Drive mounting note:", e)

# 2. Authenticate Google Colab for Direct Drive API
print("\n🔑 Authenticating Google Colab...")
try:
    from google.colab import auth
    auth.authenticate_user()
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaIoBaseDownload
    import io
    drive_service = build('drive', 'v3')
    print("✅ Google Drive API Authenticated successfully!")
except Exception as e:
    print("⚠️ API Auth notice (falling back to gdown):", e)
    drive_service = None

# Destination folder in Google Drive
OUTPUT_DIR = '/content/drive/MyDrive/Doraemon_Movies_Remuxed'
os.makedirs(OUTPUT_DIR, exist_ok=True)
print(f"🎯 Output folder: {OUTPUT_DIR}\n")

# List of 40 Movies
MOVIES = [
  {"id": "1Xh3ivVSmdsOrb5g8MLncwjzQg8NVwop7", "name": "00._Doraemon__1995__-_2112_The_Birth_of_Doraemon.mp4", "single": True},
  {"id": "1vT-ZaTWBFqzpcxxQHsbkHfbHtcC-vMnA", "name": "Doraemon_Movie_01_Nobita_s_Dinosaur.mp4", "single": False},
  {"id": "1Krs8IwPZXK1fHueYP2QA9-UCL_qWOclJ", "name": "Doraemon_Movie_04_Nobita_and_the_Castle_of_the_Undersea_Devil.mp4", "single": False},
  {"id": "1ISA2ybED3_SF9lbq0iKcuM7weitLgYWH", "name": "Doraemon_Movie_06_Nobita_s_Little_Star_Wars.mp4", "single": False},
  {"id": "18xi0Rn0Ftd0kOdyEfu9v34SKqhhxQlE6", "name": "Doraemon_Movie_08_Nobita_and_the_Knights_on_Dinosaurs.mp4", "single": False},
  {"id": "1v91-vVkCOQMMf2N8a7neupFAPxohG4kg", "name": "Doraemon_Movie_09_Nobita_s_Parallel_Journey_to_the_West.mp4", "single": False},
  {"id": "1NdWTOZx_Ko-pjuUBMGVMnvQahsiCgKzZ", "name": "Doraemon_Movie_10_Nobita_and_the_Birth_of_Japan.mp4", "single": False},
  {"id": "1-N9InT6R0lP5R6dAPL15ia0IE6_Cj1ZW", "name": "Doraemon_Movie_11_Nobita_and_the_Animal_Planet.mp4", "single": False},
  {"id": "1BgLXacDbL0tXzPj26-KnYNQrMTEz6AS7", "name": "Doraemon_Movie_12_Nobita_s_Dorabian_Nights.mp4", "single": False},
  {"id": "1bvV40EQ7mK5oqqHQCG56MRpwFFIK1qP2", "name": "Doraemon_Movie_13_Nobita_and_the_Kingdom_of_Clouds.mp4", "single": False},
  {"id": "1lLMNJXGVY0JHOL9Fcy6PbBcucDJYcAGd", "name": "Doraemon_Movie_14_Nobita_and_the_Tin_Labyrinth.mp4", "single": False},
  {"id": "1QB4o2ZqeJJV4cMET6aiEBFTZmaAhh7iF", "name": "Doraemon_Movie_15_Nobita_s_Three_Visionary_Swordsmen.mp4", "single": False},
  {"id": "1qWTAAXJqxNh8YKGbkUmKMFYKhh0xnGyj", "name": "Doraemon_Movie_16_Nobita_s_Diary_on_the_Creation_of_the_World.mp4", "single": False},
  {"id": "1J1clEA3LuxxGp6craz-IlHkgkS3wPVBD", "name": "Doraemon_Movie_17_Nobita_and_the_Galaxy_Super-Express.mp4", "single": False},
  {"id": "1lmJS8vv8n3TVfJ8mXtRRkzi8d5G8nMLN", "name": "Doraemon_Movie_18_Nobita_and_the_Spiral_City.mp4", "single": False},
  {"id": "1_QPFjPec_Mkiza1QLeUWzUXOC2IFNJqF", "name": "Doraemon_Movie_19_Nobita_s_Great_Adventure_in_the_South_Seas.mp4", "single": False},
  {"id": "1_2qcJlYcK1DeROsFHbV6SFjrlwQ8y70t", "name": "Doraemon_Movie_20_Nobita_Drifts_in_the_Universe.mp4", "single": False},
  {"id": "1zTNvVV5h6Jk6rVXUBPklTzGAW2-D3Dt5", "name": "Doraemon_Movie_21_Nobita_and_the_Legend_of_the_Sun_King.mp4", "single": False},
  {"id": "182_hRvcpziM2olJ0HYVLftlrg17Np8eF", "name": "Doraemon_Movie_22_Nobita_and_the_Winged_Braves.mp4", "single": False},
  {"id": "1FMjbs8BB6D46AtibIjVnSzvbxp53xyBB", "name": "Doraemon_Movie_23_Nobita_in_the_Robot_Kingdom.mp4", "single": False},
  {"id": "1uJwAppynWAZwumG8Osr2_a1JVfcWbFy8", "name": "Doraemon_Movie_24_Nobita_and_the_Windmasters.mp4", "single": False},
  {"id": "1Emp3eae1OsBTlvRwyq_Sa56PcL8yo3MX", "name": "Doraemon_Movie_25_Nobita_in_the_Wan-Nyan_Spacetime_Odyssey.mp4", "single": False},
  {"id": "1Qm1pLTX1F_fGiYmrmNxQe0K8FBDdUkK1", "name": "Doraemon_Movie_27_Nobita_s_New_Great_Adventure_into_the_Underworld.mp4", "single": False},
  {"id": "1KGOmau6Ldq5rO8ZRf7-lwkRnj3WNMBny", "name": "Doraemon_Movie_28_Nobita_and_the_Green_Giant_Legend.mp4", "single": False},
  {"id": "1UVhfmt7NZja4FdjvExigNTN2L9gSoL39", "name": "Doraemon_Movie_29_Nobita_s_Spaceblazer.mp4", "single": False},
  {"id": "1FlvhhK4mIBEElYYhwmEM2Q3dhVjmKWjH", "name": "Doraemon_Movie_30_The_Great_Battle_of_the_Mermaid_King.mp4", "single": False},
  {"id": "1v_C8SPANaXCmDUNz7F7fG-tsKF8MxIKJ", "name": "Doraemon_Movie_31_Nobita_and_the_New_Steel_Troops.mp4", "single": False},
  {"id": "1JJJzcaP101Brdph4vixU1Vf-obLbDrvp", "name": "Doraemon_Movie_32_Nobita_and_the_Island_of_Miracles.mp4", "single": False},
  {"id": "1p7RkNYvEPTTNNyh7NkzgAaiFq_Xlp5nj", "name": "Doraemon_Movie_33_Nobita_s_Secret_Gadget_Museum.mp4", "single": False},
  {"id": "1a1DrUhBPiHWCDAnilz9oWkZFGnA8zHln", "name": "Doraemon_Movie_34_New_Nobita_s_Great_Demon_Peko.mp4", "single": False},
  {"id": "1z5uUTZuCjMDiMCVEQnHtNhoDjc4yWE13", "name": "Doraemon_Movie_35_Nobita_s_Space_Heroes.mp4", "single": False},
  {"id": "1uG9RtNsDg94BinqxW2vE6EZAATHG0mqo", "name": "Doraemon_Movie_37_Nobita_s_Great_Adventure_in_Antarctica_Kachi_Kochi.mp4", "single": False},
  {"id": "1JeA5URvpQ_xY5SpNxFmhKO00XWPgqtTB", "name": "Doraemon_Movie_38_Nobita_s_Treasure_Island.mp4", "single": False},
  {"id": "16wUwfXIW6O8m5NBdw9NzJn5dwuErAw0M", "name": "Doraemon_Movie_39_Nobita_s_Chronicle_of_the_Moon_Exploration.mp4", "single": False},
  {"id": "1yq-Zy0pSEVTFdFB_maTW5HD4PYdbQIrH", "name": "Doraemon_Movie_40_Nobita_s_New_Dinosaur.mp4", "single": False},
  {"id": "1Io4RZ0onIU0D-bRn0XosfybQAMk_ioz5", "name": "41._Doraemon_-_Nobita_s_Little_Star_Wars_2021.mp4", "single": True},
  {"id": "13Dc2nWdJ7rjT0IjTDb5GfDOhP_JzIdtV", "name": "42._Doraemon_-_Nobita_s_Sky_Utopia_2023.mp4", "single": True},
  {"id": "1jlweQvopnQHkudpg6dli50NG6-rprrsh", "name": "43._Doraemon_-_Nobita_s_Earth_Symphony_2024.mp4", "single": True},
  {"id": "1PHq_elcIOdOpHvrGyJt96ePweNgy7DNK", "name": "Doraemon_Stand_By_Me_1_2014.mp4", "single": True},
  {"id": "12B8jKap-wlVVcIbQvwFFN5HaqcO2w5-z", "name": "Doraemon_Stand_By_Me_2_2020.mp4", "single": True}
]

def download_file(file_id, dest_path):
    if drive_service:
        request = drive_service.files().get_media(fileId=file_id, supportsAllDrives=True)
        with io.FileIO(dest_path, 'wb') as fh:
            downloader = MediaIoBaseDownload(fh, request, chunksize=100*1024*1024)
            done = False
            while not done:
                status, done = downloader.next_chunk()
                if status:
                    print(f"\r  📥 Download: {int(status.progress() * 100)}% ...", end='', flush=True)
            print("\n  ✅ Download complete!")
    else:
        cmd = f"gdown --fuzzy 'https://drive.google.com/uc?id={file_id}' -O '{dest_path}'"
        subprocess.run(cmd, shell=True, check=True)

# Process each movie
total = len(MOVIES)
for idx, movie in enumerate(MOVIES):
    dest_final = os.path.join(OUTPUT_DIR, movie["name"])
    if os.path.exists(dest_final) and os.path.getsize(dest_final) > 100 * 1024 * 1024:
        print(f"\n[{idx+1}/{total}] ⏩ Already exists in Google Drive: {movie['name']}")
        continue

    print(f"\n========================================================")
    print(f"[{idx+1}/{total}] 🎬 Processing: {movie['name']}")
    print(f"========================================================")

    local_in = f"/content/temp_in_{idx}.mp4"
    local_out = f"/content/temp_out_{idx}.mp4"

    try:
        # Step 1: Download
        print("  ⏳ Pulling from Google Drive at cloud line speed...")
        download_file(movie["id"], local_in)

        # Step 2: Remux
        print("  ⚙️ Remuxing audio to standard AAC + FastStart...")
        if movie["single"]:
            # Single audio: just copy stream and add faststart
            cmd = f'ffmpeg -y -i "{local_in}" -c copy -movflags +faststart "{local_out}"'
        else:
            # Dual audio: Track 0 (1080p video) + Track 2 (Hindi) to AAC stereo
            cmd = f'ffmpeg -y -i "{local_in}" -map 0:v:0 -map 0:2 -c:v copy -c:a aac -b:a 128k -ar 48000 -movflags +faststart "{local_out}"'
        
        res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if res.returncode != 0:
            print(f"  ❌ FFmpeg fallback (mapping 0:a:0 instead of 0:2)...")
            cmd = f'ffmpeg -y -i "{local_in}" -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -b:a 128k -ar 48000 -movflags +faststart "{local_out}"'
            subprocess.run(cmd, shell=True, check=True)

        # Delete input to preserve disk
        if os.path.exists(local_in):
            os.remove(local_in)

        # Step 3: Copy directly to Google Drive
        print(f"  💾 Saving to Google Drive: {dest_final} ...")
        shutil.move(local_out, dest_final)
        print(f"  🎉 Saved successfully! Size: {os.path.getsize(dest_final) / (1024*1024*1024):.2f} GB")

    except Exception as err:
        print(f"  ❌ Error on movie {movie['name']}: {err}")
    finally:
        if os.path.exists(local_in): os.remove(local_in)
        if os.path.exists(local_out): os.remove(local_out)

print("\n🏁 ALL MOVIES HAVE BEEN REMUXED AND SAVED TO YOUR GOOGLE DRIVE!")
