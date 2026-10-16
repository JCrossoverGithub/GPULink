"""D2A: test-only Linux procfs identity OBSERVATION, never cleanup evidence.

The witness is an operator-provisioned *test hint*, not a GPULink-launched
runtime binding. A matched PID/birth/cgroup is NOT proof of GPU isolation,
absence of descendants, or that the GPU is safe to reuse.
"""
import os
import re
from pathlib import Path

from broker_state import deny, is_id, positive, shape, strict_json
from broker_authority_bridge import _read_operator_file

BOOT_ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
FIELDS = ('attemptId','workerId','leaseId','fenceEpoch','bootId','pid','startTicks','cgroupV2')
MAX_WITNESS = 32768


def _witnesses(file_path):
    if file_path is None:
        return {}
    try:
        data = strict_json(_read_operator_file(file_path, limit=MAX_WITNESS).decode('utf-8'))
    except (UnicodeError, ValueError):
        deny('broker_invalid_host_witness')
    if not shape(data, ('schemaVersion','witnesses')) or type(data['schemaVersion']) is not int or data['schemaVersion'] != 1 or type(data['witnesses']) is not list or len(data['witnesses']) > 64:
        deny('broker_invalid_host_witness')
    result = {}
    for w in data['witnesses']:
        if not shape(w, FIELDS) or not all(is_id(w.get(k)) for k in ('attemptId','workerId','leaseId')) or \
            not positive(w['fenceEpoch']) or type(w['bootId']) is not str or not BOOT_ID.fullmatch(w['bootId']) or \
            type(w['pid']) is not int or not 1 <= w['pid'] <= 4_194_304 or not positive(w['startTicks']) or \
            type(w['cgroupV2']) is not str or not w['cgroupV2'].startswith('/') or \
            len(w['cgroupV2']) > 1024 or '\x00' in w['cgroupV2'] or '\n' in w['cgroupV2'] or \
            w['attemptId'] in result:
            deny('broker_invalid_host_witness')
        result[w['attemptId']] = dict(w)
    return result


def _boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text(encoding='ascii').strip()


def _proc_identity(pid):
    # /proc/PID/stat: comm may contain spaces and parentheses. The final ')'
    # terminates comm, then field 3 (state) starts. Starttime is field 22.
    raw = Path(f'/proc/{pid}/stat').read_text(encoding='utf-8')
    prefix, sep, tail = raw.rpartition(')')
    if not sep or not prefix.startswith(f'{pid} ('):
        raise ValueError('malformed proc stat')
    fields = tail.strip().split()
    if len(fields) < 20:
        raise ValueError('short proc stat')
    if fields[0] in ('Z', 'X', 'x'):
        raise ValueError('zombie or dead proc entry is not a live process')
    return int(fields[19])


def _cgroup_v2(pid):
    raw = Path(f'/proc/{pid}/cgroup').read_text(encoding='utf-8')
    values = [line[3:] for line in raw.splitlines() if line.startswith('0::')]
    if len(values) != 1 or not values[0].startswith('/'):
        raise ValueError('not a single cgroup v2 placement')
    return values[0]


def inspect_procfs(witness):
    """Return (state, reason). A read is a time-limited observation only."""
    try:
        before = _boot_id()
        if not BOOT_ID.fullmatch(before) or before != witness['bootId']:
            return ('unknown','boot_mismatch')
        try:
            initial = _proc_identity(witness['pid'])
        except FileNotFoundError:
            return (('absent','identity_not_present') if _boot_id() == before
                    else ('unknown','boot_mismatch'))
        if initial != witness['startTicks']:
            return (('absent','identity_not_present') if _boot_id() == before
                    else ('unknown','boot_mismatch'))
        cgroup = _cgroup_v2(witness['pid'])
        final = _proc_identity(witness['pid'])
        final_cgroup = _cgroup_v2(witness['pid'])
        after = _boot_id()
        if before != after or final != initial or cgroup != final_cgroup or cgroup != witness['cgroupV2']:
            return ('unknown','identity_changed_or_moved')
        return ('present','identity_present')
    except (OSError, ValueError, UnicodeError, OverflowError):
        return ('unknown','host_unobservable')


class HostProcessObserver:
    def __init__(self, bridge, witness_file=None):
        self.bridge = bridge
        self.witnesses = _witnesses(witness_file)

    def observe(self, peer_uid, request):
        # The worker supplies an attempt ID, not a PID, cgroup, GPU or witness.
        if not shape(request, ('attemptId',)) or not is_id(request.get('attemptId')):
            deny('broker_invalid_message')
        principal = self.bridge.ledger._principal(peer_uid)
        if principal['workerId'] != self.bridge.worker_id:
            deny('broker_unauthorized_peer')
        row = self.bridge.ledger.db.execute(
            'SELECT lease_id,worker_id,status,fence_epoch FROM remote_claims WHERE attempt_id=?',
            (request['attemptId'],)).fetchone()
        if row is None or row[1] != self.bridge.worker_id:
            deny('broker_attempt_unknown')
        witness = self.witnesses.get(request['attemptId'])
        state, reason = ('unknown','no_broker_verified_binding')
        if row[3] is None:
            reason = 'epoch_unconfirmed'
        elif witness is not None:
            if (witness['workerId'],witness['leaseId'],witness['fenceEpoch']) != (row[1],row[0],row[3]):
                reason = 'witness_identity_mismatch'
            else:
                state, reason = inspect_procfs(witness)
        return {'schemaVersion':1,'attemptId':request['attemptId'],
                'observation':state,'reason':reason,
                'source':'linux-procfs-v1' if state != 'unknown' else 'none',
                'operatorHintOnly':True,'authorityConfirmed':False,
                'cleanupVerified':False,'canLaunch':False,'canRelease':False,
                'advisoryOnly':True}
