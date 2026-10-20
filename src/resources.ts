export const RESOURCE_PAGES = [
  {
    path: '/road-conditions/', heading: 'Lake Arrowhead road conditions',
    description: 'Find Lake Arrowhead road closures, highway conditions and chain controls through official Caltrans resources.',
    body: `<p>Check conditions before traveling to or around Lake Arrowhead. Use the highway number for your route, including State Routes 18, 173 and 189.</p>
      <ul><li><a href="https://quickmap.dot.ca.gov/">Caltrans QuickMap</a> — enable the chain controls, closures, cameras and CHP incident layers, then search for Lake Arrowhead.</li>
      <li><a href="https://roads.dot.ca.gov/">Caltrans highway conditions</a> — check current reports by highway number.</li>
      <li><a href="https://dot.ca.gov/travel/winter-driving-tips/chain-controls">Caltrans chain-control guidance</a> — learn what the posted requirements mean and how to prepare.</li></ul>
      <p>Follow posted signs and instructions from Caltrans and CHP personnel. Conditions and controls can change while you travel. For recorded highway information, call <a href="tel:18004277623">800-427-7623</a>.</p>`,
  },
  {
    path: '/power-outages/', heading: 'Lake Arrowhead power outages',
    description: 'Check Southern California Edison outages near Lake Arrowhead and find Public Safety Power Shutoff alerts.',
    body: `<p>Southern California Edison provides outage information and Public Safety Power Shutoff (PSPS) notifications. Search by your address for information about your service.</p>
      <ul><li><a href="https://www.sce.com/outages-safety/outage-center/check-outage-status">SCE outage map and status</a> — check reported outages and available restoration estimates.</li>
      <li><a href="https://www.sce.com/outages-safety/outage-preparedness/outage-types/public-safety-power-shutoff-psps">SCE Public Safety Power Shutoff information</a> — find current PSPS information and options for signing up for address-level alerts.</li>
      <li><a href="https://www.sce.com/outages-safety">SCE outage and safety resources</a> — find reporting, preparation and customer support information.</li></ul>
      <p>Use SCE’s current information when checking an outage. Older news reports on this site describe the situation when they were published.</p>`,
  },
  {
    path: '/emergency-resources/', heading: 'Lake Arrowhead emergency resources',
    description: 'Find San Bernardino County emergency alerts, evacuation information and official resources for Lake Arrowhead.',
    body: `<p>Call <a href="tel:911">911</a> for an immediate emergency. For official alerts and evacuation information in Lake Arrowhead, use San Bernardino County resources.</p>
      <ul><li><a href="https://oes.sbcounty.gov/stay-informed/">County alerts and notification registration</a> — sign up for the Telephone Emergency Notification System (TENS) and find the Ready SB County app.</li>
      <li><a href="https://sbcounty.maps.arcgis.com/apps/instant/basic/index.html?appid=1acaac2939de40959f5b0254963254b8">County TENS Area Status Public Viewer</a> — check the county’s official area-status and evacuation information.</li>
      <li><a href="https://oes.sbcounty.gov/">San Bernardino County Office of Emergency Services</a> — find preparedness guidance and official updates.</li></ul>
      <p>Follow current directions from emergency personnel and official alerts. Archived community reports can provide context, but check official sources for the latest instructions.</p>`,
  },
] as const;
