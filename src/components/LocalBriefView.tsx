import type { LocalBrief } from '../lib/tactics';

interface Props {
  brief: LocalBrief;
  stamp?: string;
}

/** 本地引擎生成的分段中文战术解读：标题 + 短句列表 + 口径说明。 */
export function LocalBriefView({ brief, stamp }: Props) {
  return (
    <div className="local-brief">
      <p className="local-brief__headline">{brief.headline}</p>
      {brief.sections.map((section, i) => (
        <section className="local-brief__section" key={`${section.title}-${i}`}>
          <h3 className="local-brief__title">
            <span className="local-brief__no" aria-hidden="true">
              {i + 1}
            </span>
            {section.title}
          </h3>
          <ul className="local-brief__lines">
            {section.lines.map((line, j) => (
              <li key={`${section.title}-${j}`}>{line}</li>
            ))}
          </ul>
        </section>
      ))}
      <p className="local-brief__foot">
        {brief.footnote}
        {stamp ? <span className="local-brief__stamp">{stamp}</span> : null}
      </p>
    </div>
  );
}
