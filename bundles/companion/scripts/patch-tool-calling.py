#!/usr/bin/env python3
"""
Patch Open-LLM-VTuber's agent to fix multi-turn tool calling.

Two fixes:
1. Store tool_calls in conversation memory (basic_memory_agent.py)
   Without this, the model loses tool call patterns after turn 2.
2. Add tool_choice="auto" to the OpenAI API call (openai_compatible_llm.py)
   Without this, the model is in permissive mode and may skip tools.
"""

import sys

AGENT_FILE = "/app/src/open_llm_vtuber/agent/agents/basic_memory_agent.py"
LLM_FILE = "/app/src/open_llm_vtuber/agent/stateless_llm/openai_compatible_llm.py"


def patch_memory_system():
    """Fix: store assistant messages WITH tool_calls in memory, plus tool results."""
    with open(AGENT_FILE, "r") as f:
        content = f.read()

    # Check if already patched
    if "# [crow-patch] store tool_calls in memory" in content:
        print("patch-tool-calling: memory system already patched")
        return

    # Find the section where tool calls are processed but only text is stored:
    #   messages.append(assistant_message_for_api)
    #   if current_turn_text:
    #       self._add_message(current_turn_text, "assistant")
    #
    # Replace with: store the full assistant message (with tool_calls) AND tool results

    old = (
        'elif pending_tool_calls and assistant_message_for_api:\n'
        '                messages.append(assistant_message_for_api)\n'
        '                if current_turn_text:\n'
        '                    self._add_message(current_turn_text, "assistant")'
    )

    new = (
        'elif pending_tool_calls and assistant_message_for_api:\n'
        '                messages.append(assistant_message_for_api)\n'
        '                # [crow-patch] store tool_calls in memory for multi-turn reliability\n'
        '                self._memory.append(assistant_message_for_api)\n'
        '                if current_turn_text and not pending_tool_calls:\n'
        '                    self._add_message(current_turn_text, "assistant")'
    )

    if old not in content:
        print("patch-tool-calling: WARNING - could not find memory patch target, skipping", file=sys.stderr)
        return

    content = content.replace(old, new)

    # Also store tool results in memory. Find:
    #   if tool_results_for_llm:
    #       messages.extend(tool_results_for_llm)
    #   continue
    # (the second occurrence, after the tool executor block)

    # Find the tool results section after execute_tools
    old_results = (
        '                if tool_results_for_llm:\n'
        '                    messages.extend(tool_results_for_llm)\n'
        '                continue'
    )

    new_results = (
        '                if tool_results_for_llm:\n'
        '                    messages.extend(tool_results_for_llm)\n'
        '                    # [crow-patch] store tool results in memory\n'
        '                    for tr in tool_results_for_llm:\n'
        '                        self._memory.append(tr)\n'
        '                continue'
    )

    # Replace only the SECOND occurrence (first is the non-OpenAI path)
    count = content.count(old_results)
    if count >= 2:
        # Replace second occurrence
        first_pos = content.index(old_results)
        second_pos = content.index(old_results, first_pos + len(old_results))
        content = content[:second_pos] + new_results + content[second_pos + len(old_results):]
    elif count == 1:
        # Only one occurrence, replace it
        content = content.replace(old_results, new_results)
    else:
        print("patch-tool-calling: WARNING - could not find tool results patch target", file=sys.stderr)

    with open(AGENT_FILE, "w") as f:
        f.write(content)

    print("patch-tool-calling: patched memory system to store tool_calls")


def patch_tool_choice():
    """Fix: add tool_choice='auto' to OpenAI API calls."""
    with open(LLM_FILE, "r") as f:
        content = f.read()

    if "tool_choice" in content:
        print("patch-tool-calling: tool_choice already present")
        return

    # Find:  tools=available_tools,
    # Add:   tool_choice="auto" if available_tools else NOT_GIVEN,
    old = "                tools=available_tools,"
    new = (
        "                tools=available_tools,\n"
        '                tool_choice="auto" if available_tools else openai.NOT_GIVEN,  # [crow-patch]'
    )

    if old not in content:
        print("patch-tool-calling: WARNING - could not find tool_choice patch target", file=sys.stderr)
        return

    content = content.replace(old, new, 1)

    # Ensure openai is imported
    if "import openai" not in content:
        content = "import openai\n" + content

    with open(LLM_FILE, "w") as f:
        f.write(content)

    print("patch-tool-calling: added tool_choice='auto'")


if __name__ == "__main__":
    patch_memory_system()
    patch_tool_choice()
