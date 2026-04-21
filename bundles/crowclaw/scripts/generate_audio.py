#!/usr/bin/env python3
"""
Generate voiceover audio for the Ford video using gTTS (Google Text-to-Speech).
Run on grackle with: source ~/video-env/bin/activate && python3 generate_audio.py
"""

from gtts import gTTS
import os

# Script text - extracted from video_script.md (narration only, no stage directions)
SCRIPT_TEXT = """
Will I buy a Ford as my next vehicle? Yes—and I say that as someone who's already a Ford owner. I drive a 2020 Ford Ranger, and I chose it because, as a member of AFT Local 2048 and the AFL-CIO, I stand with the UAW and choose to buy union-made products that support our middle class. After studying Ford Motor Company this semester, that conviction has only deepened. I've come to see my purchasing choices as votes for the kind of economy I want to live in.

Ford's traditional vehicles are built by UAW workers who, under their 2023 contract, will earn up to forty-two dollars an hour by 2028. When I buy a Ford truck or SUV, I'm supporting wages that sustain the American middle class. That's a consumer choice with real economic impact—and Ford Blue proves it's possible to maintain healthy profit margins while paying union wages.

However, I would not buy a Ford electric vehicle today. Ford's EV supply chain—particularly battery production—is moving toward non-union labor and increased automation. Unless Ford commits to extending union representation throughout its electric vehicle manufacturing, I can't justify that purchase as consistent with my values.

The electrification model that Tesla pioneered, the U.S. government is funding, and Ford is following eliminates union jobs and automates production. This approach not only guts the middle class workforce—it guts the consumer base. You cannot eliminate union wages and then expect those same workers to afford the vehicles being produced. Fewer workers with living wages means fewer buyers. The transition stalls because its would-be customers have been priced out.

And beyond the labor problem, the infrastructure model itself may be flawed. Building out a national network of charging stations—analogous to gas stations—may be the most expensive and least sustainable path forward. Other models exist. China's battery swapping stations, for example, allow drivers to exchange depleted batteries for charged ones in minutes. This approach could mean lower costs for consumers and better conservation of rare earth minerals, since batteries can be maintained and recycled more efficiently. Once we've locked ourselves financially into this infrastructure, course-correcting becomes exponentially more expensive—if it remains possible at all.

So yes, I'll buy a Ford—specifically a Ford Blue vehicle, built by union workers. And I'll push for Ford to carry those values forward into the electric future, because the economy we build depends on the choices we make.

That said, I'd personally prefer not to own a car at all. A future built around driverless electric taxi services and robust public transportation may ultimately be the most sustainable path forward—for the environment, for our cities, and for how we live. Interestingly, Ford is well-positioned for that future. Their Ford Pro division already excels at fleet management. Combined with their electric vehicle development in Model e, Ford could pivot toward producing and managing fleets of union-made, self-driving taxis. If Ford can master that technology while keeping workers in the equation, they could future-proof the company. But until that future arrives, when I do buy a car, I'll buy one that supports the workers who build it.
"""

OUTPUT_FILE = "/home/kh0pp/DSCI-5330/assignment-06-video-script/audio/narration.mp3"

def generate_audio():
    """Generate audio from script text using gTTS."""
    print("Generating audio with gTTS (Google Text-to-Speech)")
    print(f"Output file: {OUTPUT_FILE}")

    # Create output directory if needed
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)

    # Create TTS object with US English and slower speed for clarity
    tts = gTTS(text=SCRIPT_TEXT.strip(), lang='en', tld='us', slow=False)

    # Save to file
    tts.save(OUTPUT_FILE)

    print(f"Audio generated successfully: {OUTPUT_FILE}")

    # Get file size
    size = os.path.getsize(OUTPUT_FILE)
    print(f"File size: {size / 1024:.1f} KB")

if __name__ == "__main__":
    generate_audio()
