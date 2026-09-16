/** Illustrative content from the supplied mockup, separate from member data. */
export function LandingPreview() {
  return (
    <section className="landing-how" aria-label="How Amazing works">
      <ol className="landing-journey">
        {['From your profile', 'Meet your people', 'At Amazing places'].map((label, i) => (
          <li key={label}><span className="journey-number">0{i + 1}</span>{label}{i < 2 && <span className="journey-arrow" aria-hidden="true">→</span>}</li>
        ))}
      </ol>
      <div className="landing-steps">
        <article className="landing-step">
          <div className="step-top"><span className="step-number">01</span><span className="brand-kicker">Start with you</span></div>
          <h3>Tell us what matters.</h3>
          <p className="step-description">Your interests, your goals, what you bring. A little context helps us find your people.</p>
          <div className="sample-card">
            <div className="sample-topline"><span>Your profile</span><span className="sample-badge">A little about you</span></div>
            <div className="sample-profile">
              <span className="sample-portrait portrait-jamie" aria-hidden="true" />
              <div><strong>Jamie Lee</strong><p>Building something new</p><span className="sample-presence">Open to meeting</span></div>
            </div>
            <div className="sample-tags"><span>Startups</span><span>Design</span><span>Good conversation</span></div>
            <div className="sample-intent"><span className="sample-label">Who I’d love to meet</span><p>“I’d love to meet people building their next big idea.”</p></div>
          </div>
        </article>
        <article className="landing-step landing-step--teal">
          <div className="step-top"><span className="step-number">02</span><span className="brand-kicker">People who fit</span></div>
          <h3>A room that fits.</h3>
          <p className="step-description">Meet people with shared interests and fresh perspectives, through introductions and curated gatherings.</p>
          <div className="sample-card">
            <div className="sample-topline"><span>Your people</span><span className="sample-badge">A shared interest</span></div>
            <div className="sample-members" aria-label="Illustrative group members">
              {[['alex', 'Alex'], ['marcus', 'Marcus'], ['sarah', 'Sarah'], ['jamie', 'You']].map(([id, name]) => (
                <figure key={id}><span className={`sample-portrait portrait-${id}`} aria-hidden="true" /><figcaption>{name}</figcaption></figure>
              ))}
            </div>
            <h4>A table of big ideas.</h4><p className="sample-subtitle">Different backgrounds. Something in common.</p>
            <p className="sample-reason">You’re all exploring what to build next — and looking for people to share the journey.</p>
          </div>
        </article>
        <article className="landing-step landing-step--places">
          <div className="step-top"><span className="step-number">03</span><span className="brand-kicker">Made for real life</span></div>
          <h3>Somewhere great.</h3>
          <p className="step-description">The right host, the right venue, the right atmosphere. From intimate dinners to bigger conversations.</p>
          <div className="sample-card sample-place">
            <img src="/brand/gathering.jpg" alt="A welcoming restaurant setting for a small gathering" loading="lazy" width="1448" height="1086" />
            <div><span className="sample-label">Your kind of gathering</span><h4>A dinner worth showing up for.</h4><p className="sample-subtitle">Thoughtful hosts. Welcoming spaces.</p></div>
          </div>
        </article>
      </div>
      <p className="sample-note">Illustrative profiles and gatherings.</p>
    </section>
  )
}
