import Link from "next/link";
import { Panel } from "#/components/ui";

export default function NotFound() {
  return (
    <main className="page">
      <Panel title="NOT FOUND">
        <div className="empty-state">
          <span>THERE&apos;S NOTHING HERE.</span>
          <Link className="btn" href="/">
            BROWSE FITS
          </Link>
        </div>
      </Panel>
    </main>
  );
}
