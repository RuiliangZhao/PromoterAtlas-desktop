import contextlib
import json
import sys
import traceback
from engine import run


def main():
    output = sys.stdout
    job = None
    def emit(kind, **payload):
        output.write(json.dumps({'protocol':1,'job_id':job,'type':kind,**payload},ensure_ascii=False,allow_nan=False)+'\n')
        output.flush()
    try:
        line = sys.stdin.readline(300_001)
        if len(line)>300_000:
            raise ValueError('Request too large')
        request=json.loads(line)
        job=request.get('job_id')
        if request.get('protocol') != 1 or not isinstance(job,str):
            raise ValueError('Unsupported protocol or missing job ID')
        emit('ready')
        with contextlib.redirect_stdout(sys.stderr):
            result=run(request,lambda done,total,stage:emit('progress',done=done,total=total,stage=stage))
        emit('result',result=result)
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        emit('error',message=str(error))
        return 1
    return 0

if __name__=='__main__':
    raise SystemExit(main())
