import { useState, type ReactNode } from 'react';
import { Tabs, tabPanelProps } from './kit';

/**
 * Knowledge is one place with one entry in the navigation. What XO knows (approved knowledge, disagreements, what waits for review)
 * and the records it was learned from stay two views of it, because each has its own search and showing both at once would put two
 * unlike searches on one page. The address `/knowledge/search` opens the records view.
 */
export function KnowledgeScreen(props: { initial: 'known' | 'records'; known: ReactNode; records: ReactNode }) {
  const [tab, setTab] = useState<string>(props.initial);
  return (
    <>
      <Tabs
        label="Knowledge views"
        idBase="kn"
        current={tab}
        onSelect={setTab}
        items={[
          { id: 'known', label: 'What XO knows' },
          { id: 'records', label: 'Records' },
        ]}
      />
      <div {...tabPanelProps('kn', tab)}>{tab === 'known' ? props.known : props.records}</div>
    </>
  );
}
