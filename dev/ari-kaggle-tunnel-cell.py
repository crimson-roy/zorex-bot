"""Paste this whole file into a NEW Kaggle code cell after the authenticated API cell."""

import hashlib
import json
import os
import platform
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request


def _ari_cloudflared_executable():
    installed = shutil.which("cloudflared")
    if installed:
        subprocess.run([installed, "--version"], check=True, capture_output=True, text=True, timeout=10)
        return installed

    machine = platform.machine().lower()
    if machine not in ("x86_64", "amd64"):
        raise RuntimeError("Automatic cloudflared setup supports Kaggle Linux x86-64 only. Install the official Cloudflare build for this architecture manually.")

    request = urllib.request.Request(
        "https://api.github.com/repos/cloudflare/cloudflared/releases/latest",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "Ari-Kaggle-Development-Tunnel"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        release = json.loads(response.read(2 * 1024 * 1024).decode("utf-8"))
    asset = next((item for item in release.get("assets", []) if item.get("name") == "cloudflared-linux-amd64"), None)
    expected_match = re.search(r"(?m)^\s*cloudflared-linux-amd64:\s*([0-9a-fA-F]{64})\s*$", release.get("body", ""))
    if not asset or not expected_match:
        raise RuntimeError("The official Cloudflare release did not provide the expected binary and SHA-256 checksum; no executable was installed.")
    download_url = asset.get("browser_download_url", "")
    if not download_url.startswith("https://github.com/cloudflare/cloudflared/releases/download/"):
        raise RuntimeError("The official Cloudflare release asset URL was not valid; no executable was installed.")

    install_dir = tempfile.mkdtemp(prefix="ari-cloudflared-")
    executable = os.path.join(install_dir, "cloudflared")
    with urllib.request.urlopen(download_url, timeout=60) as response, open(executable, "wb") as output:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
    digest = hashlib.sha256()
    with open(executable, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest().lower() != expected_match.group(1).lower():
        os.remove(executable)
        raise RuntimeError("The Cloudflare binary checksum did not match the official release; the file was removed and not run.")
    os.chmod(executable, 0o700)
    subprocess.run([executable, "--version"], check=True, capture_output=True, text=True, timeout=10)
    return executable


def start_ari_cloudflare_quick_tunnel(namespace):
    current = namespace.get("ARI_CLOUDFLARED_PROCESS")
    current_url = namespace.get("ARI_CLOUDFLARED_URL")
    if current is not None and current.poll() is None and current_url:
        print("Quick Tunnel is already running:", current_url)
        return current, current_url
    api_thread = namespace.get("ARI_GPU_API_THREAD")
    if namespace.get("ARI_GPU_API_SERVER") is None or api_thread is None or not api_thread.is_alive():
        raise RuntimeError("Start the authenticated Ari GPU API cell before opening the tunnel.")

    executable = _ari_cloudflared_executable()
    process = subprocess.Popen(
        [executable, "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:8765"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    lines = queue.Queue()

    def collect_output():
        for line in process.stdout:
            lines.put(line.rstrip())

    reader = threading.Thread(target=collect_output, name="ari-cloudflared-output", daemon=True)
    reader.start()
    pattern = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com", re.I)
    recent = []
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if process.poll() is not None:
            break
        try:
            line = lines.get(timeout=0.5)
        except queue.Empty:
            continue
        recent.append(line)
        recent = recent[-12:]
        match = pattern.search(line)
        if match:
            url = match.group(0)
            namespace["ARI_CLOUDFLARED_PROCESS"] = process
            namespace["ARI_CLOUDFLARED_READER"] = reader
            namespace["ARI_CLOUDFLARED_URL"] = url

            def monitor_process():
                exit_code = process.wait()
                if namespace.get("ARI_CLOUDFLARED_PROCESS") is process:
                    if exit_code == 0:
                        print("[Ari Tunnel] cloudflared stopped.")
                    else:
                        print("[Ari Tunnel] cloudflared exited unexpectedly with code", exit_code)

            monitor = threading.Thread(target=monitor_process, name="ari-cloudflared-monitor", daemon=True)
            monitor.start()
            namespace["ARI_CLOUDFLARED_MONITOR"] = monitor
            print("Temporary Quick Tunnel URL:", url)
            print("The bearer-protected API remains at /health and /v1/chat. The URL changes when the tunnel restarts.")
            return process, url
    if process.poll() is None:
        process.terminate()
        raise RuntimeError("cloudflared did not produce a Quick Tunnel URL within 90 seconds.")
    raise RuntimeError("cloudflared exited before the tunnel was ready: " + " | ".join(recent[-6:]))


if globals().get("__name__") == "__main__":
    ARI_CLOUDFLARED_PROCESS, ARI_CLOUDFLARED_URL = start_ari_cloudflare_quick_tunnel(globals())
