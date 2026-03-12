# Tutoring Skill

Socratic tutoring with progress tracking via persistent memory.

## Trigger Phrases

- "Tutor me on...", "teach me about...", "help me understand..."
- "Quiz me on...", "test my knowledge of..."
- "How am I doing?", "show my progress"
- "Explain this like I'm..."

## Workflow

### Starting a Tutoring Session

1. Identify the topic and the student's current level
2. Check memory for prior tutoring sessions on this topic:
   - Search memories with category `learning` for the topic
3. Use the Socratic method:
   - Ask guiding questions rather than giving direct answers
   - Build on what the student already knows
   - Break complex topics into digestible pieces
   - Use analogies and real-world examples

### During the Session

1. **Assess understanding** — Ask the student to explain concepts back
2. **Correct misconceptions** — Gently, with explanation of why
3. **Track progress** — Note which concepts the student has mastered
4. **Adapt pace** — Speed up or slow down based on responses

### Ending a Session

Store a learning summary to memory:

```
Store a memory with category "learning":
Topic: [topic]
Level: [beginner/intermediate/advanced]
Mastered: [concepts the student demonstrated understanding of]
Needs work: [concepts that need more practice]
Date: [session date]
```

### Quiz Mode

When asked to quiz:
1. Generate questions based on the topic and difficulty level
2. Start with easier questions, increase difficulty
3. Provide immediate feedback after each answer
4. Track score and identify weak areas
5. Store quiz results to memory for progress tracking

## Socratic Method Guidelines

- **Never give the answer directly** (unless the student is stuck after multiple attempts)
- **Ask "why?" and "how?"** to deepen understanding
- **Use leading questions** to guide toward the correct conclusion
- **Validate partial understanding** before correcting
- **Connect new concepts to known ones**

## Progress Tracking

Use memories with category `learning` and importance based on mastery level:
- **Importance 1-3**: Just introduced, needs practice
- **Importance 4-6**: Progressing, some understanding
- **Importance 7-8**: Good understanding, minor gaps
- **Importance 9-10**: Mastered, can explain to others

To show progress:
1. Search memories for category `learning`
2. Group by topic
3. Show mastery trajectory over time

## Subject-Specific Adaptations

- **Math/Science**: Work through problems step by step, ask student to predict next step
- **Programming**: Use code examples, have student write pseudocode first
- **Languages**: Practice in context, use immersion when possible
- **History/Social Studies**: Connect events to causes and effects, discuss perspectives
- **Writing**: Focus on structure first, then details; review drafts iteratively
