import asyncio
import sys
import os
from playwright.async_api import async_playwright

sys.stdout.reconfigure(encoding='utf-8')

LIVE_URL = "https://cartoon-server-50046883835.development.catalystappsail.in"
SCREENSHOT_PATH = r"C:\Users\admin\Desktop\rea\playwright_player_test.png"

async def run_test():
    print(f"🎬 Starting Playwright Test on: {LIVE_URL}")
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={'width': 1280, 'height': 800})
        page = await context.new_page()

        # 1. Navigate to Live AppSail Player
        print("1. Navigating to live web player...")
        response = await page.goto(LIVE_URL, wait_until="networkidle", timeout=30000)
        print(f"   HTTP Status: {response.status}")

        title = await page.title()
        print(f"   Page Title: {title}")
        assert "Cartoon Stream" in title, f"Unexpected title: {title}"

        # 2. Verify Online Status
        pill = await page.inner_text("#status-pill")
        print(f"   Status Pill: {pill}")
        assert "ONLINE" in pill

        # 3. Verify Show Tabs
        tabs = await page.query_selector_all(".tab")
        print(f"2. Found {len(tabs)} Show Tabs:")
        for t in tabs:
            txt = await t.inner_text()
            print(f"   - {txt}")
        assert len(tabs) >= 3

        # 4. Test Lucky Man Episode 1 Playback
        print("3. Testing Lucky Man Episode 1 Playback...")
        # Click Lucky Man tab if not active
        await tabs[0].click()
        await page.wait_for_selector(".ep-card", timeout=10000)
        await page.wait_for_timeout(1000)

        ep_cards = await page.query_selector_all(".ep-card")
        print(f"   Found {len(ep_cards)} episodes in grid")
        assert len(ep_cards) >= 50, f"Expected 50 episodes, got {len(ep_cards)}"

        # Click first episode card via locator
        await page.locator(".ep-card").first.click()

        # Wait for video element to have src
        await page.wait_for_function("document.getElementById('video-element').src !== ''", timeout=10000)
        video_src = await page.eval_on_selector("#video-element", "v => v.src")
        print(f"   Video Source: {video_src}")
        assert "api/stream" in video_src

        # Wait for video playback to advance
        print("   Waiting for video playback stream...")
        await page.wait_for_timeout(3000)
        current_time = await page.eval_on_selector("#video-element", "v => v.currentTime")
        duration = await page.eval_on_selector("#video-element", "v => v.duration")
        print(f"   Current Time: {current_time:.2f}s / {duration:.2f}s")

        # 5. Test 'Skip Intro (+90s)' button
        print("4. Testing Skip Intro (+90s)...")
        await page.click("#btn-skip-intro")
        await page.wait_for_timeout(2000)
        time_after_skip = await page.evaluate("() => getEffectiveCurrentTime()")
        print(f"   Current Time After Skip: {time_after_skip:.2f}s")
        assert time_after_skip >= 80, f"Expected >= 80s, got {time_after_skip}s"

        # 5a. TEST TIMESTAMP JUMPING INPUT (e.g. 05:00 = 300s)
        print("4a. Testing Jump to Timestamp Input ('05:00')...")
        await page.fill("#jump-time-input", "05:00")
        await page.click("#btn-jump")
        await page.wait_for_timeout(2000)
        time_after_jump = await page.evaluate("() => getEffectiveCurrentTime()")
        print(f"   Time After Jump to 05:00: {time_after_jump:.2f}s")
        assert 290 <= time_after_jump <= 320, f"Expected ~300s, got {time_after_jump}s"
        print("   ✅ Jump to Specific Timestamp ('05:00' -> 300s) VERIFIED!")

        # 5b. TEST QUICK +30s SKIP BUTTON
        print("4b. Testing +30s Skip Button...")
        await page.click("#btn-fwd-30")
        await page.wait_for_timeout(2000)
        time_after_fwd = await page.evaluate("() => getEffectiveCurrentTime()")
        print(f"   Time After +30s Skip: {time_after_fwd:.2f}s")
        assert time_after_fwd >= 320, f"Expected >= 320s, got {time_after_fwd}s"
        print("   ✅ Quick +30s Skip VERIFIED!")

        # 6. TEST DYNAMIC AUDIO LANGUAGE SWITCHING
        print("5. Testing Dynamic Audio Language Switching...")
        # Wait for audio select to populate with detected tracks
        await page.wait_for_function("document.getElementById('audio-select').options.length >= 3", timeout=10000)
        audio_options = await page.eval_on_selector("#audio-select", "sel => Array.from(sel.options).map(o => ({ value: o.value, text: o.text }))")
        print(f"   Detected Audio Tracks: {audio_options}")
        assert len(audio_options) >= 3, f"Expected at least 3 audio tracks, got {len(audio_options)}"

        # Switch to Tamil (value="1")
        print("   Switching Audio to Tamil (value='1')...")
        await page.select_option("#audio-select", "1")
        await page.wait_for_timeout(2000)
        tamil_src = await page.eval_on_selector("#video-element", "v => v.src")
        print(f"   Video Source after Tamil switch: {tamil_src}")
        assert "audio=1" in tamil_src, f"Expected 'audio=1' in src, got {tamil_src}"

        # Switch to Telugu (value="2")
        print("   Switching Audio to Telugu (value='2')...")
        await page.select_option("#audio-select", "2")
        await page.wait_for_timeout(2000)
        telugu_src = await page.eval_on_selector("#video-element", "v => v.src")
        print(f"   Video Source after Telugu switch: {telugu_src}")
        assert "audio=2" in telugu_src, f"Expected 'audio=2' in src, got {telugu_src}"
        print("   ✅ Dynamic Audio Switching VERIFIED!")

        # 7. Test Switching to Pokémon
        print("6. Testing Pokémon Catalog & Season Switch...")
        await tabs[1].click() # Click Pokemon tab
        await page.wait_for_timeout(1500)

        # Check season selector
        seasons_options = await page.eval_on_selector("#season-select", "sel => Array.from(sel.options).map(o => o.text)")
        print(f"   Pokemon Seasons in dropdown: {len(seasons_options)}")
        print(f"   First 3 seasons: {seasons_options[:3]}")
        assert len(seasons_options) >= 20

        # Click first Pokemon episode
        print("   Clicking first Pokemon episode...")
        await page.locator(".ep-card").first.click()
        await page.wait_for_timeout(2000)

        poke_src = await page.eval_on_selector("#video-element", "v => v.src")
        print(f"   Pokemon Video Source: {poke_src}")
        assert "Pokemon" in poke_src

        # 8. Test Switching to Doraemon Theatrical Movies
        print("7. Testing Doraemon Theatrical Movies Tab...")
        await tabs[2].click() # Click Doraemon tab
        await page.wait_for_timeout(1500)
        dora_cards = await page.query_selector_all(".ep-card")
        print(f"   Doraemon Movies in grid: {len(dora_cards)}")
        assert len(dora_cards) == 40, f"Expected 40 Doraemon movies, got {len(dora_cards)}"

        # Click first Doraemon movie
        print("   Clicking first Doraemon movie...")
        await page.locator(".ep-card").first.click()
        await page.wait_for_timeout(2000)
        dora_src = await page.eval_on_selector("#video-element", "v => v.src")
        print(f"   Doraemon Movie Source: {dora_src}")
        assert "Doraemon" in dora_src

        # 9. Take full-page screenshot
        print(f"8. Capturing full-page screenshot to: {SCREENSHOT_PATH}...")
        await page.screenshot(path=SCREENSHOT_PATH, full_page=False)
        print("   Screenshot saved successfully!")

        await browser.close()
        print("\n🎉 ALL PLAYWRIGHT TESTS PASSED 100%!")

if __name__ == "__main__":
    asyncio.run(run_test())
