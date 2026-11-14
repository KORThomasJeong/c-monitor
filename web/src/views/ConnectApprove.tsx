// 컴퓨터 연결 승인(/connect?code=XXXX-XXXX). 목업 Connect.dc.html 구조 그대로.
import type { MeResponse } from '@c-monitor/shared';
import { useState, type FormEvent } from 'react';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { AlertIcon, CheckIcon, InfoIcon, PcIcon } from '../components/Icons';
import { normalizeUserCode } from '../lib/format';
import { useTheme } from '../lib/prefs';
import { Link, navigate } from '../router';

type Step = 'confirm' | 'busy' | 'done' | 'failed' | 'denied';

export function ConnectApprove({ me, code }: { me: MeResponse; code: string | null }) {
  const theme = useTheme();
  const userCode = code ? normalizeUserCode(code) : '';
  const [step, setStep] = useState<Step>('confirm');
  const [machineName, setMachineName] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');

  const approve = async () => {
    setStep('busy');
    try {
      const res = await api.approveDevice(userCode);
      setMachineName(res?.machineName ?? null);
      setStep('done');
    } catch (e) {
      const expired = e instanceof ApiError && [400, 404, 409, 410].includes(e.status);
      setReason(expired
        ? '코드가 만료되었거나 맞지 않습니다. 터미널에서 연결 명령을 다시 실행해 주세요.'
        : '서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
      setStep('failed');
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = normalizeUserCode(typed);
    if (c) navigate(`/connect?code=${encodeURIComponent(c)}`);
  };

  let body;
  if (!userCode) {
    body = (
      <form onSubmit={submit} style={{ display: 'contents' }}>
        <div className="auth-head">
          <span className="brand-mark" aria-hidden="true"><PcIcon size={24} /></span>
          <h1 className="h1" style={{ fontSize: 20 }}>컴퓨터 연결</h1>
          <p className="sub" style={{ margin: 0 }}>터미널에 보이는 연결 코드를 넣어 주세요.</p>
        </div>
        <div className="field">
          <label htmlFor="user-code">연결 코드</label>
          <input
            id="user-code"
            className="input code-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </div>
        <button type="submit" className="btn primary block">확인</button>
      </form>
    );
  } else if (step === 'done') {
    body = (
      <>
        <div className="auth-head">
          <span className="brand-mark" style={{ background: 'var(--ok)' }} aria-hidden="true"><CheckIcon size={24} /></span>
          <h1 className="h1" style={{ fontSize: 20 }}>연결했습니다</h1>
          <p className="sub" style={{ margin: 0 }}>{machineName ?? '이 컴퓨터'}의 세션이 이제 대시보드에 나타납니다. 이 창은 닫아도 됩니다.</p>
        </div>
        <Link className="btn primary block" to="/">대시보드 열기</Link>
      </>
    );
  } else if (step === 'failed') {
    body = (
      <>
        <div className="auth-head">
          <span className="brand-mark" style={{ background: 'var(--danger)' }} aria-hidden="true"><AlertIcon size={24} /></span>
          <h1 className="h1" style={{ fontSize: 20 }}>연결하지 못했습니다</h1>
          <p className="sub" style={{ margin: 0 }}>{reason}</p>
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => navigate('/connect')}>코드 입력</button>
          <button type="button" className="btn primary" onClick={approve}>다시 시도</button>
        </div>
      </>
    );
  } else if (step === 'denied') {
    body = (
      <>
        <div className="auth-head">
          <h1 className="h1" style={{ fontSize: 20 }}>연결하지 않았습니다</h1>
          <p className="sub" style={{ margin: 0 }}>터미널의 연결 요청은 10분이 지나면 저절로 만료됩니다. 다시 연결하려면 명령을 새로 실행해 주세요.</p>
        </div>
        <button type="button" className="btn block" onClick={() => setStep('confirm')}>처음으로</button>
      </>
    );
  } else {
    body = (
      <>
        <div className="auth-head">
          <span className="brand-mark" aria-hidden="true"><PcIcon size={24} /></span>
          <h1 className="h1" style={{ fontSize: 20 }}>이 컴퓨터를 연결할까요?</h1>
          <p className="sub" style={{ margin: 0 }}>터미널에 보이는 코드와 같은지 확인해 주세요.</p>
        </div>
        <div className="code-big" aria-label="연결 코드">{userCode}</div>
        <div className="dl">
          <div className="dl-row"><span className="k">승인하는 사람</span><span className="v">{me.user.email}</span></div>
        </div>
        <div className="notice">
          <InfoIcon size={16} />
          <span>승인하면 이 컴퓨터의 클로드코드 대화가 서버로 전송됩니다. 비밀번호·API 키는 가려서 보내고, 설정 화면에서 언제든 연결을 해제할 수 있습니다.</span>
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => setStep('denied')} disabled={step === 'busy'}>거부</button>
          <button type="button" className="btn primary" onClick={approve} disabled={step === 'busy'}>
            {step === 'busy' ? '승인 중' : '연결 승인'}
          </button>
        </div>
      </>
    );
  }

  return (
    <div className={`app ${theme.cls}`}>
      <div className="center">
        <div className="auth">{body}</div>
      </div>
    </div>
  );
}
