from app.runner import _recent_turns_chat_messages


def test_recent_turns_last_three_pairs():
    messages = [
        {"role": "user", "content": "old"},
        {"role": "assistant", "content": "a1"},
        {"role": "user", "content": "mid"},
        {"role": "assistant", "content": "a2"},
        {"role": "user", "content": "new"},
        {"role": "assistant", "content": "a3"},
    ]
    chat = _recent_turns_chat_messages(messages, max_turns=3)
    assert chat == [
        {"role": "user", "content": "old"},
        {"role": "assistant", "content": "a1"},
        {"role": "user", "content": "mid"},
        {"role": "assistant", "content": "a2"},
        {"role": "user", "content": "new"},
        {"role": "assistant", "content": "a3"},
    ]


def test_recent_turns_truncates_to_three_when_more():
    messages = [
        {"role": "user", "content": "u1"},
        {"role": "assistant", "content": "x1"},
        {"role": "user", "content": "u2"},
        {"role": "assistant", "content": "x2"},
        {"role": "user", "content": "u3"},
        {"role": "assistant", "content": "x3"},
        {"role": "user", "content": "u4"},
        {"role": "assistant", "content": "x4"},
    ]
    chat = _recent_turns_chat_messages(messages, max_turns=3)
    assert chat[0] == {"role": "user", "content": "u2"}
    assert chat[-2:] == [
        {"role": "user", "content": "u4"},
        {"role": "assistant", "content": "x4"},
    ]
