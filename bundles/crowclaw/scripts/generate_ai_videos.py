#!/usr/bin/env python3
"""
Generate AI video clips for the Ford video using Runware API.
Run on grackle with: source ~/video-env/bin/activate && python3 generate_ai_videos.py

API Key: se9LgAoBMzDHSAdRxMtV2LARvZkx8TkS
Budget: $24.73 (after images ~$23)
Video cost: ~$0.14 per generation
"""

import asyncio
import os
import httpx
from runware import Runware, IVideoInference

# Runware API key
API_KEY = "se9LgAoBMzDHSAdRxMtV2LARvZkx8TkS"

# Output directory
OUTPUT_DIR = "/home/kh0pp/DSCI-5330/assignment-06-video-script/video_clips/ai_generated"

# Video prompts - 4 hero clips for key dramatic moments
# CRITICAL: All prompts must avoid text
VIDEO_PROMPTS = [
    {
        "filename": "v01_factory_workers.mp4",
        "prompt": "Factory workers in motion, diverse group welding and assembling automotive parts on assembly line, sparks flying, industrial atmosphere, warm lighting, cinematic, professional documentary style",
        "duration": 5
    },
    {
        "filename": "v02_robotic_automation.mp4",
        "prompt": "Robotic arms assembling car batteries in automated factory, cold blue industrial lighting, sterile environment, robots moving in synchronized motion, dystopian industrial feel, cinematic",
        "duration": 5
    },
    {
        "filename": "v03_economic_decline.mp4",
        "prompt": "Slow pan across closed factory gates, abandoned industrial building, empty parking lot, overcast sky, economic decline atmosphere, melancholy cinematic style",
        "duration": 5
    },
    {
        "filename": "v04_autonomous_future.mp4",
        "prompt": "Fleet of futuristic autonomous electric taxis driving through modern city street, sleek clean vehicles, optimistic future vision, blue sky, cinematic wide shot",
        "duration": 5
    },
]


async def download_video(url, filepath):
    """Download video from URL and save to file."""
    async with httpx.AsyncClient() as client:
        response = await client.get(url, timeout=120.0)
        response.raise_for_status()
        with open(filepath, 'wb') as f:
            f.write(response.content)


async def generate_videos():
    """Generate AI video clips using Runware API."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print(f"Generating {len(VIDEO_PROMPTS)} AI video clips...")
    print(f"Output directory: {OUTPUT_DIR}")
    print(f"Estimated cost: ~${len(VIDEO_PROMPTS) * 0.14:.2f}")
    print()

    # Initialize Runware client
    runware = Runware(api_key=API_KEY)
    await runware.connect()

    generated = 0
    failed = 0

    for i, vid_data in enumerate(VIDEO_PROMPTS):
        filename = vid_data["filename"]
        prompt = vid_data["prompt"]
        duration = vid_data["duration"]
        filepath = os.path.join(OUTPUT_DIR, filename)

        # Skip if already exists
        if os.path.exists(filepath):
            print(f"[{i+1}/{len(VIDEO_PROMPTS)}] Skipping {filename} (already exists)")
            generated += 1
            continue

        print(f"[{i+1}/{len(VIDEO_PROMPTS)}] Generating {filename} ({duration}s)...")

        try:
            # Create video inference request
            # Using klingai model which is affordable and good quality
            # Kling AI supports exact 1920x1080 for 16:9
            request = IVideoInference(
                positivePrompt=prompt,
                model="klingai:5@3",  # Kling AI model
                duration=duration,
                width=1920,
                height=1080,  # Exact 1080p supported by Kling AI
            )

            # Generate video - returns async task or list
            result = await runware.videoInference(requestVideo=request)

            # Handle result - could be list or single object
            if result is None:
                print(f"    ERROR: No result returned for {filename}")
                failed += 1
            elif isinstance(result, list):
                if len(result) > 0:
                    video_url = result[0].videoURL
                    await download_video(video_url, filepath)
                    print(f"    Saved: {filename}")
                    generated += 1
                else:
                    print(f"    ERROR: Empty result list for {filename}")
                    failed += 1
            else:
                # Single object response
                video_url = getattr(result, 'videoURL', None)
                if video_url:
                    await download_video(video_url, filepath)
                    print(f"    Saved: {filename}")
                    generated += 1
                else:
                    # Check for async task response
                    print(f"    Result type: {type(result)}")
                    print(f"    Result attrs: {dir(result)}")
                    failed += 1

        except Exception as e:
            print(f"    ERROR generating {filename}: {e}")
            import traceback
            traceback.print_exc()
            failed += 1

    print()
    print(f"Video generation complete!")
    print(f"  Generated: {generated}")
    print(f"  Failed: {failed}")
    print(f"  Total: {len(VIDEO_PROMPTS)}")


if __name__ == "__main__":
    asyncio.run(generate_videos())
