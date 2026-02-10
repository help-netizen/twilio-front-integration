// Mock API for Workiz Leads - simulates backend responses

import type { 
  Lead, 
  LeadsListParams, 
  LeadsListResponse, 
  CreateLeadInput,
  UpdateLeadInput,
  AssignLeadInput 
} from '../types/lead';

// Generate mock leads data
const generateMockLeads = (count: number): Lead[] => {
  const statuses = ['New', 'Contacted', 'Qualified', 'Proposal Sent', 'Negotiation', 'Lost', 'Converted'];
  const jobTypes = ['Plumbing', 'HVAC', 'Electrical', 'Carpentry', 'Landscaping', 'Painting', 'Roofing'];
  const jobSources = ['Website', 'Referral', 'Google Ads', 'Facebook', 'Yelp', 'Direct Call', 'Email'];
  const teams = ['Team Alpha', 'Team Beta', 'Team Gamma'];
  const users = ['John Smith', 'Sarah Johnson', 'Mike Davis', 'Emma Wilson', 'Chris Brown'];
  const cities = ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia', 'San Antonio'];
  const states = ['NY', 'CA', 'IL', 'TX', 'AZ', 'PA', 'TX'];
  
  const firstNames = ['John', 'Sarah', 'Michael', 'Emily', 'David', 'Jessica', 'Chris', 'Amanda', 'Daniel', 'Lisa'];
  const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez'];
  const companies = ['ABC Corp', 'XYZ Inc', 'Tech Solutions', 'Global Services', 'Pro Systems', null, null, null];

  const leads: Lead[] = [];
  const now = new Date();

  for (let i = 0; i < count; i++) {
    const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
    const company = companies[Math.floor(Math.random() * companies.length)];
    const cityIndex = Math.floor(Math.random() * cities.length);
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    const isLost = status === 'Lost';
    
    // Generate dates in the past 30 days
    const daysAgo = Math.floor(Math.random() * 30);
    const leadDate = new Date(now);
    leadDate.setDate(leadDate.getDate() - daysAgo);
    leadDate.setHours(8 + Math.floor(Math.random() * 10), Math.floor(Math.random() * 60), 0, 0);

    const createdDate = new Date(leadDate);
    createdDate.setHours(createdDate.getHours() - Math.floor(Math.random() * 24));

    leads.push({
      UUID: `lead-${String(i + 1).padStart(4, '0')}-${Date.now()}`,
      SerialId: `L${String(10000 + i).slice(-5)}`,
      ClientId: `client-${String(i + 1).padStart(4, '0')}`,
      
      CreatedDate: createdDate.toISOString(),
      LeadEndDateTime: new Date(leadDate.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      Timezone: 'America/New_York',
      
      Status: status,
      SubStatus: status === 'Contacted' ? 'Follow-up needed' : undefined,
      LeadLost: isLost,
      
      FirstName: firstName,
      LastName: lastName,
      Company: company || undefined,
      Phone: `+1${Math.floor(Math.random() * 900 + 100)}${Math.floor(Math.random() * 900 + 100)}${Math.floor(Math.random() * 9000 + 1000)}`,
      Email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
      
      Address: `${Math.floor(Math.random() * 9999 + 1)} Main St`,
      City: cities[cityIndex],
      State: states[cityIndex],
      PostalCode: String(Math.floor(Math.random() * 90000 + 10000)),
      Country: 'USA',
      
      JobType: jobTypes[Math.floor(Math.random() * jobTypes.length)],
      JobSource: jobSources[Math.floor(Math.random() * jobSources.length)],
      LeadNotes: Math.random() > 0.5 ? 'Customer called about urgent service needed.' : undefined,
      Comments: Math.random() > 0.6 ? 'Follow up on Friday' : undefined,
      Team: teams[Math.floor(Math.random() * teams.length)],
    });
  }

  // Sort by CreatedDate desc (most recent first)
  return leads.sort((a, b) => new Date(b.CreatedDate).getTime() - new Date(a.CreatedDate).getTime());
};

// In-memory storage for mock data
let mockLeads = generateMockLeads(75);

// Simulate API delay
const delay = (ms: number = 300) => new Promise(resolve => setTimeout(resolve, ms));

// Mock API functions
export const mockLeadsAPI = {
  // List leads with filters
  async list(params: LeadsListParams): Promise<LeadsListResponse> {
    await delay();
    
    let filtered = [...mockLeads];
    
    // Filter by start_date
    if (params.start_date) {
      const startDate = new Date(params.start_date);
      filtered = filtered.filter(lead => new Date(lead.CreatedDate) >= startDate);
    }
    
    // Filter by only_open
    if (params.only_open) {
      filtered = filtered.filter(lead => !lead.LeadLost && lead.Status !== 'Converted' && lead.Status !== 'Lost');
    }
    
    // Filter by status
    if (params.status && params.status.length > 0) {
      filtered = filtered.filter(lead => params.status!.includes(lead.Status));
    }
    
    // Pagination
    const offset = params.offset || 0;
    const records = params.records || 100;
    const results = filtered.slice(offset, offset + records);
    const has_more = offset + records < filtered.length;
    
    return {
      results,
      offset,
      records,
      has_more
    };
  },

  // Get single lead details
  async get(uuid: string): Promise<Lead | null> {
    await delay();
    return mockLeads.find(lead => lead.UUID === uuid) || null;
  },

  // Create new lead
  async create(input: CreateLeadInput): Promise<Lead> {
    await delay(400);
    
    const newLead: Lead = {
      UUID: `lead-new-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      SerialId: `L${String(10000 + mockLeads.length)}`,
      ClientId: `client-new-${Date.now()}`,
      
      CreatedDate: new Date().toISOString(),
      Timezone: 'America/New_York',
      
      Status: input.Status || 'New',
      LeadLost: false,
      
      FirstName: input.FirstName,
      LastName: input.LastName,
      Company: input.Company,
      Phone: input.Phone,
      Email: input.Email,
      
      Address: input.Address,
      City: input.City,
      State: input.State,
      PostalCode: input.PostalCode,
      Country: 'USA',
      
      JobType: input.JobType,
      JobSource: input.JobSource,
      LeadNotes: input.LeadNotes,
      Team: 'Team Alpha',
    };
    
    mockLeads.unshift(newLead);
    return newLead;
  },

  // Update lead
  async update(input: UpdateLeadInput): Promise<Lead> {
    await delay(400);
    
    const index = mockLeads.findIndex(lead => lead.UUID === input.UUID);
    if (index === -1) {
      throw new Error('Lead not found');
    }
    
    mockLeads[index] = {
      ...mockLeads[index],
      ...input,
      UUID: input.UUID, // Preserve UUID
    };
    
    return mockLeads[index];
  },

  // Mark lead as lost
  async markLost(uuid: string): Promise<Lead> {
    await delay(300);
    
    const index = mockLeads.findIndex(lead => lead.UUID === uuid);
    if (index === -1) {
      throw new Error('Lead not found');
    }
    
    mockLeads[index] = {
      ...mockLeads[index],
      Status: 'Lost',
      LeadLost: true,
    };
    
    return mockLeads[index];
  },

  // Activate lead
  async activate(uuid: string): Promise<Lead> {
    await delay(300);
    
    const index = mockLeads.findIndex(lead => lead.UUID === uuid);
    if (index === -1) {
      throw new Error('Lead not found');
    }
    
    mockLeads[index] = {
      ...mockLeads[index],
      Status: 'New',
      LeadLost: false,
    };
    
    return mockLeads[index];
  },

  // Assign lead to user
  async assign(input: AssignLeadInput): Promise<Lead> {
    await delay(300);
    
    const index = mockLeads.findIndex(lead => lead.UUID === input.UUID);
    if (index === -1) {
      throw new Error('Lead not found');
    }
    
    // For now, just return the lead unchanged since we removed AssignedUser
    return mockLeads[index];
  },

  // Unassign lead
  async unassign(uuid: string): Promise<Lead> {
    await delay(300);
    
    const index = mockLeads.findIndex(lead => lead.UUID === uuid);
    if (index === -1) {
      throw new Error('Lead not found');
    }
    
    // For now, just return the lead unchanged since we removed AssignedUser
    return mockLeads[index];
  },

  // Convert lead to job
  async convert(uuid: string): Promise<{ lead: Lead; jobId: string }> {
    await delay(500);
    
    const index = mockLeads.findIndex(lead => lead.UUID === uuid);
    if (index === -1) {
      throw new Error('Lead not found');
    }
    
    mockLeads[index] = {
      ...mockLeads[index],
      Status: 'Converted',
    };
    
    return {
      lead: mockLeads[index],
      jobId: `job-${Date.now()}`
    };
  },

  // Delete lead
  async delete(uuid: string): Promise<void> {
    await delay(300);
    
    const index = mockLeads.findIndex(lead => lead.UUID === uuid);
    if (index === -1) {
      throw new Error('Lead not found');
    }
    
    mockLeads.splice(index, 1);
  },
};