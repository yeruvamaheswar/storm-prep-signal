"""Tick loop entry: python -m server.engine --tape PATH | --live [--tape PATH]"""
import sys

from server.engine.loop import main

if __name__ == "__main__":
    sys.exit(main())
