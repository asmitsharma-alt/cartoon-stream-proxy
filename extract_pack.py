import os
import sys
import zipfile

def extract_archive(zip_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    print(f"[extract_pack] Opening archive: {zip_path}")
    with zipfile.ZipFile(zip_path, 'r') as z:
        for member in z.infolist():
            lower = member.filename.lower()
            if lower.endswith(('.mkv', '.mp4')):
                filename = os.path.basename(member.filename)
                if filename:
                    target_path = os.path.join(out_dir, filename)
                    print(f"  -> Extracting: {filename} ({member.file_size / (1024*1024):.1f} MB)")
                    with z.open(member) as source, open(target_path, "wb") as target:
                        while True:
                            chunk = source.read(1024 * 1024)
                            if not chunk:
                                break
                            target.write(chunk)
    print(f"[extract_pack] Extraction complete into: {out_dir}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python extract_pack.py <zip_path> <out_dir>")
        sys.exit(1)
    extract_archive(sys.argv[1], sys.argv[2])
