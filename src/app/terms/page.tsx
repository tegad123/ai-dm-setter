export default function TermsOfService() {
  return (
    <div className='mx-auto max-w-3xl px-6 py-12'>
      <h1 className='mb-6 text-3xl font-bold'>Terms of Service</h1>
      <p className='text-muted-foreground mb-8 text-sm'>
        Last updated: March 21, 2026
      </p>

      <div className='space-y-6 text-sm leading-relaxed'>
        <section>
          <h2 className='mb-2 text-xl font-semibold'>1. Acceptance of Terms</h2>
          <p>
            By using DMsetter, you agree to these Terms of Service. If you do
            not agree, do not use the service.
          </p>
        </section>

        <section>
          <h2 className='mb-2 text-xl font-semibold'>
            2. Description of Service
          </h2>
          <p>
            DMsetter is an AI-powered messaging platform that helps businesses
            manage and automate responses to Facebook Messenger and Instagram
            Direct Messages. The service includes lead tracking, conversation
            analytics, and AI reply generation.
          </p>
        </section>

        <section>
          <h2 className='mb-2 text-xl font-semibold'>
            3. Account Responsibilities
          </h2>
          <p>
            You are responsible for maintaining the security of your account
            credentials and for all activity that occurs under your account. You
            must have proper authorization to connect any Facebook Page or
            Instagram account to DMsetter.
          </p>
        </section>

        <section>
          <h2 className='mb-2 text-xl font-semibold'>4. Acceptable Use</h2>
          <p>You agree not to use DMsetter to:</p>
          <ul className='mt-2 list-disc space-y-1 pl-6'>
            <li>Send spam or unsolicited messages</li>
            <li>Violate Meta&apos;s Platform Terms or Community Standards</li>
            <li>Engage in deceptive or fraudulent practices</li>
            <li>Harass or abuse message recipients</li>
          </ul>
        </section>

        <section>
          <h2 className='mb-2 text-xl font-semibold'>
            5. AI-Generated Content
          </h2>
          <p>
            AI-generated replies are suggestions. You are responsible for
            reviewing and approving messages sent through the platform. DMsetter
            is not liable for the content of AI-generated messages.
          </p>
        </section>

        <section>
          <h2 className='mb-2 text-xl font-semibold'>
            6. Limitation of Liability
          </h2>
          <p>
            DMsetter is provided &quot;as is&quot; without warranties of any
            kind. We are not liable for any damages arising from the use of the
            service, including but not limited to loss of data, revenue, or
            business opportunities.
          </p>
        </section>

        <section>
          <h2 className='mb-2 text-xl font-semibold'>7. Termination</h2>
          <p>
            We reserve the right to suspend or terminate your account at any
            time for violation of these terms. You may cancel your account at
            any time by disconnecting your integrations and contacting support.
          </p>
        </section>

        <section>
          <h2 className='mb-2 text-xl font-semibold'>8. Contact</h2>
          <p>
            For questions about these terms, contact us at
            support@scalevault.ai.
          </p>
        </section>
      </div>
    </div>
  );
}
