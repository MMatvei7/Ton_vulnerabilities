import random
import sys
import json

def generate_mixed_messages(n):
    messages = [i for i in range(1, n + 1)]
    random.shuffle(messages)
    return messages

if __name__ == "__main__":
    if len(sys.argv) > 1:
        n = int(sys.argv[1])
        result = generate_mixed_messages(n)
        print(' '.join(map(str, result)))