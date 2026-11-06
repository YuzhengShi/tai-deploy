"""Point the orchestrator at the image the harness runs on (tai.EVAL_IMAGE: tai-agent:clean, the agent runner compiled at container start from the
mounted source) and restart it. Every harness script that calls tai.orch_env(**tai.EVAL_IMAGE) does this itself; this is for a stack that is
used by hand.   python3 use_image.py [KEY=VALUE ...]   (more orch.env settings to apply at the same time)"""
import sys

import tai

extra = dict(a.split("=", 1) for a in sys.argv[1:])
print(tai.orch_env(**{**tai.EVAL_IMAGE, **extra}))
print(tai.sh("bash %s/eval/host/remote/stack.sh status" % tai.T))
