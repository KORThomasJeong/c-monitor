// 설정·관리자 화면 틀. 목업 Admin.dc.html의 .admin-page 구조(왼쪽 메뉴가 스크롤을 따라다님).
import type { MeResponse } from '@c-monitor/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { useTheme } from '../lib/prefs';
import { Header } from './Header';

type Props = {
  me: MeResponse;
  page: 'settings' | 'admin';
  tag?: string;
  title: string;
  desc: string;
  nav: [id: string, label: string][];
  menuLabel: string;
  actions?: ReactNode;
  children: ReactNode;
};

export function SidePage({ me, page, tag, title, desc, nav, menuLabel, actions, children }: Props) {
  const theme = useTheme();
  const [active, setActive] = useState(nav[0]?.[0] ?? '');

  // 스크롤 위치에 맞춰 메뉴 강조를 옮긴다.
  useEffect(() => {
    const onScroll = () => {
      let cur = nav[0]?.[0] ?? '';
      for (const [id] of nav) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 120) cur = id;
      }
      setActive(cur);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [nav]);

  return (
    <div className={`app admin-page ${theme.cls}`}>
      <Header me={me} page={page} tag={tag} dark={theme.dark} onToggleTheme={theme.toggle} actions={actions} />
      <div className="admin-wrap">
        <nav className="side" aria-label={menuLabel}>
          <div className="nav">
            {nav.map(([id, label]) => (
              <a key={id} href={`#${id}`} className={active === id ? 'on' : ''} aria-current={active === id ? 'true' : undefined} onClick={() => setActive(id)}>
                {label}
              </a>
            ))}
          </div>
        </nav>
        <div className="content">
          <div>
            <h1 className="h1">{title}</h1>
            <p className="sub">{desc}</p>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

/** 목업의 .sec 카드. 제목이 영역 이름이 된다. */
export function Sec({ id, title, desc, aside, body, children }: {
  id: string; title: string; desc?: string; aside?: ReactNode; body?: boolean; children: ReactNode;
}) {
  return (
    <section className="sec" id={id} aria-labelledby={`${id}-title`}>
      <div className="sec-head">
        <div>
          <h2 className="sec-title" id={`${id}-title`}>{title}</h2>
          {desc && <p className="sec-desc">{desc}</p>}
        </div>
        {aside}
      </div>
      {body ? <div className="sec-body">{children}</div> : children}
    </section>
  );
}
